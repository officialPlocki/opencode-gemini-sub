/**
 * Connection profiles.
 *
 * Both profiles speak the same Cloud Code Assist transport, but they differ in
 * OAuth client, scopes, host, headers and the request envelope. Keeping them in
 * one table makes the client and the proxy profile-agnostic.
 *
 * `gemini-cli` is the original Gemini CLI identity. Google now rejects it for
 * the individual tier (`UNSUPPORTED_CLIENT`), but it still works for paid
 * Code Assist tiers with a Cloud project.
 *
 * `antigravity` mirrors Google's Antigravity Hub client, which is the current
 * path for consumer Gemini access.
 */

import { OAUTH_CLIENT_ENV } from "./constants.ts";
import type { GeminiModel } from "./models.ts";

export type ProfileID = "gemini-cli" | "antigravity";

export interface OAuthProfile {
  clientId: string;
  clientSecret: string;
  scopes: string[];
  /** Path of the loopback callback, the port is ephemeral. */
  callbackPath: string;
}

export interface Profile {
  id: ProfileID;
  providerID: string;
  name: string;
  /** File name inside the plugin data directory. */
  credentialsFile: string;
  endpoint: string;
  oauth: OAuthProfile;
  /** `loadCodeAssist` / `onboardUser` metadata. */
  metadata: Record<string, string>;
  /** Template with `{model}`, `{os_type}`, `{arch}`, `{version}`. */
  userAgent: string;
  /** Envelope dialect. */
  envelope: "cli" | "antigravity";
  /** Whether `fetchAvailableModels` is available. */
  discovery: boolean;
  /** Extra headers for content requests. */
  headers: Record<string, string>;
  /** Fallback catalogue; replaced by discovery data when available. */
  models: GeminiModel[];
}

const model = (
  id: string,
  name: string,
  family: string,
  context: number,
  output: number,
  options: { tools?: boolean; released?: string } = {},
): GeminiModel => ({
  id,
  name,
  family,
  released: options.released ?? "2026-01-01",
  context,
  output,
  tools: options.tools ?? true,
  multimodal: true,
  thinking: true,
  freeTier: false,
});

export const ANTIGRAVITY_FALLBACK_MODELS: GeminiModel[] = [
  model("gemini-3.8-flash-high", "Gemini 3.8 Flash (High)", "gemini-3", 1_048_576, 65_536, { released: "2026-09-16" }),
  model("gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)", "gemini-3", 1_048_576, 65_536, { released: "2026-09-16" }),
  model("gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)", "gemini-3", 1_048_576, 65_536, { released: "2026-09-16" }),
  // Tiered route used by the IDE's Pro selection; the backend picks the model.
  model("gemini-3.8-flash-tiered", "Gemini 3.8 Flash (Tiered)", "gemini-3", 1_048_576, 65_536, { released: "2026-09-16" }),
  model("gemini-3.7-flash-high", "Gemini 3.7 Flash (High)", "gemini-3", 1_048_576, 65_536, { released: "2026-08-12" }),
  model("gemini-3.7-flash-medium", "Gemini 3.7 Flash (Medium)", "gemini-3", 1_048_576, 65_536, { released: "2026-08-12" }),
  model("gemini-3.7-flash-low", "Gemini 3.7 Flash (Low)", "gemini-3", 1_048_576, 65_536, { released: "2026-08-12" }),
  model("gemini-3.6-flash-high", "Gemini 3.6 Flash (High)", "gemini-3", 1_048_576, 65_536, { released: "2026-07-08" }),
  model("gemini-3.6-flash-medium", "Gemini 3.6 Flash (Medium)", "gemini-3", 1_048_576, 65_536, { released: "2026-07-08" }),
  model("gemini-3.6-flash-low", "Gemini 3.6 Flash (Low)", "gemini-3", 1_048_576, 65_536, { released: "2026-07-08" }),
  model("gemini-3.5-flash-low", "Gemini 3.5 Flash (Low)", "gemini-3", 1_048_576, 65_536, { released: "2026-04-22" }),
  model("gemini-3-flash-agent", "Gemini 3 Flash (Agent)", "gemini-3", 1_048_576, 65_536, { released: "2026-02-05" }),
  model("gemini-3.1-pro-low", "Gemini 3.1 Pro (Low)", "gemini-3", 1_048_576, 65_535, { released: "2026-06-10" }),
  // The backend advertises `gemini-3.1-pro-high` but rejects it; the Hub's own
  // high-effort route is this id.
  model("gemini-pro-agent", "Gemini 3.1 Pro (High)", "gemini-3", 1_048_576, 65_535, { released: "2026-06-10" }),
  model("gemini-3-flash", "Gemini 3 Flash", "gemini-3", 1_048_576, 65_536, { released: "2026-02-05" }),
  model("claude-sonnet-4-6", "Claude Sonnet 4.6 (Antigravity)", "claude", 200_000, 64_000, { released: "2026-02-05" }),
  model("claude-opus-4-6-thinking", "Claude Opus 4.6 Thinking (Antigravity)", "claude", 250_000, 64_000, { released: "2026-02-05" }),
  model("gpt-oss-120b-medium", "GPT-OSS 120B (Antigravity)", "gpt-oss", 131_072, 32_768, {
    released: "2026-01-01",
  }),
];

export const GEMINI_CLI_MODELS: GeminiModel[] = [
  model("gemini-3.8-flash", "Gemini 3.8 Flash", "gemini-3", 1_048_576, 65_536),
  model("gemini-3.5-flash", "Gemini 3.5 Flash", "gemini-3", 1_048_576, 65_536),
  model("gemini-3.1-pro-preview", "Gemini 3.1 Pro (preview)", "gemini-3", 1_048_576, 65_536),
  model("gemini-3-pro-preview", "Gemini 3 Pro (preview)", "gemini-3", 1_048_576, 65_536),
  model("gemini-2.5-pro", "Gemini 2.5 Pro", "gemini-2.5", 1_048_576, 65_536),
  model("gemini-2.5-flash", "Gemini 2.5 Flash", "gemini-2.5", 1_048_576, 65_536),
];

/** Map a Node platform to the value the Hub reports in its User-Agent. */
export function osType(platform = process.platform): string {
  switch (platform) {
    case "darwin":
      return "darwin";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

export function buildAntigravityUserAgent(version = "2.24.0"): string {
  return `antigravity/hub/${version} (aidev_client; os_type=${osType()}; arch=${process.arch}; cl=1000335682)`;
}

export interface OAuthClientIdentity {
  clientId?: string;
  clientSecret?: string;
}

export interface ProfileInput {
  endpoint?: string;
  antigravityVersion?: string;
  antigravityUseLegacyHeaders?: boolean;
  /** Per-profile OAuth application identity. No defaults are shipped. */
  clients?: Partial<Record<ProfileID, OAuthClientIdentity>>;
}

export function createProfiles(input: ProfileInput = {}): Profile[] {
  const version = input.antigravityVersion ?? "2.24.0";
  const clientFor = (id: ProfileID): { clientId: string; clientSecret: string } => {
    const env = OAUTH_CLIENT_ENV[id];
    const configured = input.clients?.[id];
    return {
      clientId: configured?.clientId || process.env[env.id] || "",
      clientSecret: configured?.clientSecret || process.env[env.secret] || "",
    };
  };
  const antigravityHeaders: Record<string, string> = input.antigravityUseLegacyHeaders
    ? {
        "x-goog-api-client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
        "client-metadata": JSON.stringify({
          ideType: "ANTIGRAVITY",
          platform: "PLATFORM_UNSPECIFIED",
          pluginType: "GEMINI",
        }),
      }
    : {};

  return [
    {
      id: "antigravity",
      providerID: "antigravity",
      name: "Antigravity",
      credentialsFile: "antigravity.json",
      endpoint: input.endpoint ?? "https://daily-cloudcode-pa.googleapis.com",
      oauth: {
        ...clientFor("antigravity"),
        scopes: [
          "https://www.googleapis.com/auth/cloud-platform",
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/userinfo.profile",
          "https://www.googleapis.com/auth/cclog",
          "https://www.googleapis.com/auth/experimentsandconfigs",
          "openid",
        ],
        callbackPath: "/oauth-callback",
      },
      metadata: {
        ideType: "ANTIGRAVITY",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
      userAgent: `antigravity/hub/${version} (aidev_client; os_type={os_type}; arch={arch}; cl=1000335682)`,
      envelope: "antigravity",
      discovery: true,
      headers: antigravityHeaders,
      models: ANTIGRAVITY_FALLBACK_MODELS,
    },
    {
      id: "gemini-cli",
      providerID: "gemini-sub",
      name: "Gemini",
      credentialsFile: "credentials.json",
      endpoint: input.endpoint ?? "https://cloudcode-pa.googleapis.com",
      oauth: {
        ...clientFor("gemini-cli"),
        scopes: [
          "https://www.googleapis.com/auth/cloud-platform",
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/userinfo.profile",
        ],
        callbackPath: "/oauth2callback",
      },
      metadata: {
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
      userAgent: "GeminiCLI/0.30.0/{model} ({platform}; {arch}; CLI)",
      envelope: "cli",
      discovery: false,
      headers: {},
      models: GEMINI_CLI_MODELS,
    },
  ];
}
