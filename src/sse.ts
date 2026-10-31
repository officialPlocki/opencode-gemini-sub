/**
 * Stream translation between the Code Assist envelope and the plain Gemini
 * REST representation that OpenCode's Google provider speaks.
 *
 * Upstream events look like:
 *   data: {"response":{"candidates":[...]},"traceId":"..."}
 *
 * Downstream (Gemini API) events look like:
 *   data: {"candidates":[...]}
 *
 * Keeping this as a pure, incremental parser makes it testable without a
 * network and lets the proxy stream byte-for-byte with low latency.
 */

export interface UnwrapResult {
  /** JSON-serializable payload to forward, or undefined for empty events. */
  payload?: unknown;
  /** Set when the upstream sent an error object inside the stream. */
  error?: { code?: number; message?: string; status?: string; details?: unknown[] };
}

/** Extract the inner response from one parsed SSE payload. */
export function unwrapEvent(value: unknown): UnwrapResult {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  if (record["error"] && typeof record["error"] === "object") {
    return { error: record["error"] as UnwrapResult["error"] };
  }
  if ("response" in record) {
    const response = record["response"];
    if (response === null || response === undefined) return {};
    return { payload: response };
  }
  // Some backend versions stream the bare GenerateContentResponse.
  return { payload: value };
}

/** Convert a non-streaming `{response: ...}` body into a Gemini API response. */
export function unwrapResponseBody(value: unknown): unknown {
  if (value && typeof value === "object" && "response" in (value as Record<string, unknown>)) {
    return (value as Record<string, unknown>)["response"] ?? {};
  }
  return value;
}

export class SseUnwrapper {
  #buffer = "";

  /** Feed a decoded chunk, get zero or more complete SSE frames back. */
  push(chunk: string): string[] {
    this.#buffer += chunk;
    const frames: string[] = [];
    let boundary = this.#findBoundary();
    while (boundary.index >= 0) {
      const block = this.#buffer.slice(0, boundary.index);
      this.#buffer = this.#buffer.slice(boundary.index + boundary.length);
      const frame = this.#translate(block);
      if (frame) frames.push(frame);
      boundary = this.#findBoundary();
    }
    return frames;
  }

  /** Flush a trailing event that was not terminated by a blank line. */
  flush(): string[] {
    const rest = this.#buffer.trim();
    this.#buffer = "";
    if (!rest) return [];
    const frame = this.#translate(rest);
    return frame ? [frame] : [];
  }

  #findBoundary(): { index: number; length: number } {
    const lf = this.#buffer.indexOf("\n\n");
    const crlf = this.#buffer.indexOf("\r\n\r\n");
    if (lf < 0 && crlf < 0) return { index: -1, length: 0 };
    if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
    return { index: lf, length: 2 };
  }

  #translate(block: string): string | undefined {
    const data: string[] = [];
    for (const rawLine of block.split(/\r?\n/)) {
      if (!rawLine.startsWith("data:")) continue;
      data.push(rawLine.slice(5).trimStart());
    }
    if (data.length === 0) return undefined;
    const text = data.join("\n");
    if (!text || text === "[DONE]") return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    const { payload, error } = unwrapEvent(parsed);
    if (error) {
      return `data: ${JSON.stringify({ error })}\n\n`;
    }
    if (payload === undefined) return undefined;
    return `data: ${JSON.stringify(payload)}\n\n`;
  }
}
