/**
 * Protocol constants for the Code Assist ("cloudcode-pa") backend.
 *
 * Everything in this file was derived by observing the public HTTP traffic of
 * the Gemini CLI (OAuth endpoints, method names, request envelopes). No code
 * was copied from Google; the only literals that must match byte-for-byte are
 * protocol identifiers and the public installed-app OAuth client identity,
 * because Google's backend validates them.
 */

/** Provider id used inside OpenCode, e.g. `gemini-sub/gemini-2.5-pro`. */
export const PROVIDER_ID = "gemini-sub";

/** Display name of the provider in `/models` and `/connect`. */
export const PROVIDER_NAME = "Gemini (subscription)";

/** Backend that serves Gemini CLI / Code Assist traffic. */
export const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";

/** Version segment of the backend, the methods live behind `v1internal:<method>`. */
export const CODE_ASSIST_VERSION = "v1internal";

/** OAuth authorization endpoint (installed-app / loopback flow). */
export const OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** OAuth token endpoint for code exchange and refresh. */
export const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Userinfo endpoint, used to label the account in `/gemini-status`. */
export const OAUTH_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

/**
 * Scopes requested by the Gemini CLI login. `cloud-platform` is the one that
 * grants Code Assist access; the other two only let us display the account.
 */
export const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
] as const;

/**
 * OAuth application identity is supplied by the user.
 *
 * No Google client id or secret is shipped in this repository. Provide the
 * installed-app credentials of the client whose entitlement you use through
 * these environment variables, or through the plugin's `oauth` options.
 */
export const OAUTH_CLIENT_ENV = {
  antigravity: {
    id: "OPENCODE_ANTIGRAVITY_CLIENT_ID",
    secret: "OPENCODE_ANTIGRAVITY_CLIENT_SECRET",
  },
  "gemini-cli": {
    id: "OPENCODE_GEMINI_SUB_CLIENT_ID",
    secret: "OPENCODE_GEMINI_SUB_CLIENT_SECRET",
  },
} as const;

/** Identifier reported to `loadCodeAssist` so the backend returns CLI tiers. */
export const CLIENT_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
} as const;

/** Default `User-Agent`; the shape is part of the emulated client identity. */
export const DEFAULT_USER_AGENT =
  "GeminiCLI/0.30.0/{model} ({platform}; {arch}; CLI)";

/** Default plugin data directory (credentials, quota snapshots). */
export const DATA_DIR_NAME = "opencode-gemini-sub";

/** Gemini CLI credential file, imported on first start when present. */
export const GEMINI_CLI_CREDENTIAL_PATHS = [
  ".gemini/oauth_creds.json",
  ".config/gemini/oauth_creds.json",
] as const;
