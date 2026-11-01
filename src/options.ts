/**
 * Plugin options. All fields are optional; the defaults are what a normal
 * user wants. Unknown fields are ignored so an older plugin keeps working
 * after a config gains a new option.
 */

import type { GeminiModel } from "./models.ts";
import type { ProfileID } from "./profiles.ts";

export interface PluginOptions {
  /** Enabled connection profiles. */
  profiles: ProfileID[];
  /** OAuth application identity per profile. No defaults are shipped. */
  oauth?: Partial<Record<ProfileID, { clientId?: string; clientSecret?: string }>>;
  /** Antigravity Hub version reported in the User-Agent. */
  antigravityVersion?: string;
  /** Send the older Antigravity header set (X-Goog-Api-Client, Client-Metadata). */
  antigravityUseLegacyHeaders: boolean;
  /** Wait for a quota reset and continue the same request. */
  autoContinue: boolean;
  /** Maximum time to park a request for a quota reset. 0 means unlimited. */
  maxQuotaWaitMs: number;
  /** SSE comment interval while a request is parked. */
  keepAliveMs: number;
  /** Maximum parallel upstream requests. */
  concurrency: number;
  /** Import `~/.gemini/oauth_creds.json` when no credentials are stored. */
  importGeminiCLI: boolean;
  /** Ask Gemini models to return thought summaries (`includeThoughts`). */
  includeThoughts: boolean;
  /** Send usage metrics to Google like the CLI does. */
  telemetry: boolean;
  /** Emulated `User-Agent`. */
  userAgent?: string;
  /** Override the Code Assist endpoint (tests, proxies). */
  endpoint?: string;
  /** Return canned responses instead of calling Google. */
  mock: boolean;
  /** Additional or overriding model definitions. */
  models?: (Partial<GeminiModel> & { id: string })[];
  /** Override the credential directory. */
  dataDir?: string;
  /** Force a Cloud project id instead of resolving it via the backend. */
  projectId?: string;
  /** Print proxy decisions to the server log. */
  debug: boolean;
}

export const DEFAULT_OPTIONS: PluginOptions = {
  profiles: ["antigravity", "gemini-cli"],
  antigravityUseLegacyHeaders: false,
  autoContinue: true,
  maxQuotaWaitMs: 24 * 3_600_000,
  keepAliveMs: 15_000,
  concurrency: 2,
  importGeminiCLI: true,
  includeThoughts: true,
  telemetry: false,
  mock: false,
  debug: false,
};

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function num(value: unknown, fallback: number, min = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

export function parseOptions(input: unknown): PluginOptions {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const requested = Array.isArray(raw["profiles"])
    ? (raw["profiles"] as unknown[]).filter(
        (value): value is ProfileID => value === "antigravity" || value === "gemini-cli",
      )
    : DEFAULT_OPTIONS.profiles;
  return {
    profiles: requested.length > 0 ? [...new Set(requested)] : DEFAULT_OPTIONS.profiles,
    oauth: parseOAuth(raw["oauth"]),
    antigravityVersion: typeof raw["antigravityVersion"] === "string" ? raw["antigravityVersion"] : undefined,
    antigravityUseLegacyHeaders: bool(
      raw["antigravityUseLegacyHeaders"],
      DEFAULT_OPTIONS.antigravityUseLegacyHeaders,
    ),
    autoContinue: bool(raw["autoContinue"], DEFAULT_OPTIONS.autoContinue),
    maxQuotaWaitMs: num(raw["maxQuotaWaitMs"], DEFAULT_OPTIONS.maxQuotaWaitMs),
    keepAliveMs: Math.max(1_000, num(raw["keepAliveMs"], DEFAULT_OPTIONS.keepAliveMs, 1_000)),
    concurrency: Math.max(1, Math.floor(num(raw["concurrency"], DEFAULT_OPTIONS.concurrency, 1))),
    importGeminiCLI: bool(raw["importGeminiCLI"], DEFAULT_OPTIONS.importGeminiCLI),
    includeThoughts: bool(raw["includeThoughts"], DEFAULT_OPTIONS.includeThoughts),
    telemetry: bool(raw["telemetry"], DEFAULT_OPTIONS.telemetry),
    userAgent: typeof raw["userAgent"] === "string" ? raw["userAgent"] : undefined,
    endpoint: typeof raw["endpoint"] === "string" ? raw["endpoint"] : undefined,
    mock: bool(raw["mock"], DEFAULT_OPTIONS.mock),
    models: Array.isArray(raw["models"]) ? (raw["models"] as PluginOptions["models"]) : undefined,
    dataDir: typeof raw["dataDir"] === "string" ? raw["dataDir"] : undefined,
    projectId: typeof raw["projectId"] === "string" ? raw["projectId"] : undefined,
    debug: bool(raw["debug"], DEFAULT_OPTIONS.debug),
  };
}


function parseOAuth(input: unknown): PluginOptions["oauth"] {
  if (!input || typeof input !== "object") return undefined;
  const result: NonNullable<PluginOptions["oauth"]> = {};
  for (const id of ["antigravity", "gemini-cli"] as const) {
    const value = (input as Record<string, unknown>)[id];
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    result[id] = {
      clientId: typeof entry["clientId"] === "string" ? entry["clientId"] : undefined,
      clientSecret: typeof entry["clientSecret"] === "string" ? entry["clientSecret"] : undefined,
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
