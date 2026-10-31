/**
 * Classification of Code Assist failures.
 *
 * The backend answers with Google RPC error envelopes. The interesting cases
 * for a subscription client are:
 *   - short rate limits (retry after N seconds)
 *   - daily / monthly quota exhaustion (only a reset time helps)
 *   - capacity problems (retry, but do not burn the quota forever)
 *   - auth problems (refresh the token)
 *
 * We only rely on documented Google RPC detail types, never on a message that
 * is specific to one client version.
 */

export type ErrorKind =
  | "quota"
  | "rate-limit"
  | "capacity"
  | "auth"
  | "validation"
  | "bad-request"
  | "server"
  | "unknown";

export interface ClassifiedError {
  kind: ErrorKind;
  status: number;
  message: string;
  /** Best guess for when the request may succeed again, epoch ms. */
  resetAt?: number;
  /** Suggested delay in ms, without a reset timestamp. */
  retryAfterMs?: number;
  /** Set when the limit cannot be recovered by waiting (billing cap, zero quota). */
  terminal: boolean;
  /** Raw details for diagnostics. */
  details: unknown[];
}

interface RpcDetail {
  "@type"?: string;
  retryDelay?: string;
  reason?: string;
  domain?: string;
  violations?: { quotaId?: string; quotaMetric?: string; quotaValue?: string }[];
}

const TYPE_PREFIX = "type.googleapis.com/google.rpc.";

/** Parse protobuf duration strings such as `3.5s`, `120s`, `1.5m`, `2h`. */
export function parseDurationMs(value: string | undefined | null): number | undefined {
  if (!value) return undefined;
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m|h)?\s*$/i.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  switch ((match[2] ?? "s").toLowerCase()) {
    case "ms":
      return amount;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
    default:
      return amount * 1000;
  }
}

/**
 * Pull a reset delay out of prose. The backend uses a few phrasings:
 * "Please retry in 23.4s", "reset after 3h 4m", "try again in 2 minutes".
 */
export function parseProseDelayMs(message: string): number | undefined {
  const retry = /retry in\s+([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m|h)?/i.exec(message);
  if (retry) return parseDurationMs(`${retry[1]}${retry[2] ?? "s"}`);
  const reset = /reset(?:s|ting)?\s+(?:after|in)\s+((?:[0-9]+\s*[hms]\s*)+)/i.exec(message);
  if (reset) {
    let total = 0;
    const parts = (reset[1] ?? "").matchAll(/([0-9]+)\s*([hms])/gi);
    for (const part of parts) {
      const amount = Number(part[1] ?? 0);
      const unit = (part[2] ?? "s").toLowerCase();
      total += unit === "h" ? amount * 3_600_000 : unit === "m" ? amount * 60_000 : amount * 1000;
    }
    if (total > 0) return total;
  }
  const minutes = /(?:try again|available)\s+in\s+([0-9]+)\s+minutes?/i.exec(message);
  if (minutes) return Number(minutes[1]) * 60_000;
  return undefined;
}

function isSpendingCap(message: string): boolean {
  return /spending cap|billing (?:limit|cap)|monthly limit|credit balance|limit:\s*0(?!\d|\.\d)/i.test(
    message,
  );
}

function isDailyLimit(message: string, details: RpcDetail[]): boolean {
  if (/daily (?:quota|limit)|per[- ]day|exhausted your daily/i.test(message)) return true;
  return details.some((detail) =>
    (detail.violations ?? []).some((violation) =>
      /perday|daily|per_day/i.test(`${violation.quotaId ?? ""} ${violation.quotaMetric ?? ""}`),
    ),
  );
}

/** Parse a Google RPC error body, tolerating plain text and empty bodies. */
export function parseErrorBody(body: string): {
  status?: number;
  message: string;
  details: RpcDetail[];
} {
  const trimmed = body.trim();
  if (!trimmed) return { message: "", details: [] };
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { code?: number; message?: string; status?: string; details?: unknown[] };
    };
    const error = parsed.error;
    if (error) {
      return {
        status: error.code,
        message: error.message ?? error.status ?? trimmed,
        details: (error.details ?? []).filter(
          (detail): detail is RpcDetail => typeof detail === "object" && detail !== null,
        ),
      };
    }
  } catch {
    // Fall through to plain text handling.
  }
  return { message: trimmed.slice(0, 2000), details: [] };
}

/**
 * Turn an upstream failure into a decision the proxy can act on.
 */
export function classifyError(
  status: number,
  headers: Headers | Record<string, string | undefined>,
  body: string,
  now = Date.now(),
): ClassifiedError {
  const parsed = parseErrorBody(body);
  const message = parsed.message || `Upstream returned HTTP ${status}`;
  const details = parsed.details;
  const headerGet = (name: string): string | undefined =>
    headers instanceof Headers ? (headers.get(name) ?? undefined) : headers[name.toLowerCase()];

  const base = {
    status,
    message,
    details: details as unknown[],
  };

  if (status === 401) return { ...base, kind: "auth", terminal: false };
  if (status === 403) {
    const validation = details.some((detail) => detail.reason === "VALIDATION_REQUIRED");
    if (validation) return { ...base, kind: "validation", terminal: true };
    if (/invalid authentication|unauthenticated|credential/i.test(message)) {
      return { ...base, kind: "auth", terminal: false };
    }
    return { ...base, kind: "auth", terminal: false };
  }
  if (status === 400 || status === 404 || status === 405) {
    // A spending cap arrives as a plain 400 but is not a request problem.
    if (isSpendingCap(message)) return { ...base, kind: "quota", terminal: true };
    return { ...base, kind: "bad-request", terminal: true };
  }

  if (status !== 429 && status !== 499 && status !== 503) {
    if (status >= 500) return { ...base, kind: "server", terminal: false };
    return { ...base, kind: "unknown", terminal: status >= 400 };
  }

  const retryInfo = details.find((detail) => detail["@type"] === `${TYPE_PREFIX}RetryInfo`);
  const errorInfo = details.find((detail) => detail["@type"] === `${TYPE_PREFIX}ErrorInfo`);
  const delayMs =
    parseDurationMs(retryInfo?.retryDelay) ??
    parseDurationMs(headerGet("retry-after") ? `${headerGet("retry-after")}s` : undefined) ??
    parseProseDelayMs(message);

  if (isSpendingCap(message)) {
    return { ...base, kind: "quota", terminal: true, retryAfterMs: delayMs };
  }
  if (errorInfo?.reason === "MODEL_CAPACITY_EXHAUSTED" || errorInfo?.reason === "MODEL_CAPACITY_EXCEEDED") {
    return { ...base, kind: "capacity", terminal: false, retryAfterMs: delayMs ?? 30_000 };
  }
  if (isDailyLimit(message, details)) {
    return {
      ...base,
      kind: "quota",
      terminal: false,
      retryAfterMs: delayMs,
      resetAt: delayMs === undefined ? undefined : now + delayMs,
    };
  }
  if (delayMs !== undefined) {
    // A long delay is a quota window, a short one a rate limit.
    return {
      ...base,
      kind: delayMs > 10 * 60_000 ? "quota" : "rate-limit",
      terminal: false,
      retryAfterMs: delayMs,
      resetAt: now + delayMs,
    };
  }
  return { ...base, kind: "rate-limit", terminal: false, retryAfterMs: 60_000, resetAt: now + 60_000 };
}

/** Human readable one-liner for logs and the status command. */
export function describeError(error: ClassifiedError): string {
  const when = error.resetAt ? ` (reset ${new Date(error.resetAt).toISOString()})` : "";
  return `[${error.kind}${error.terminal ? ", terminal" : ""}] ${error.message}${when}`;
}
