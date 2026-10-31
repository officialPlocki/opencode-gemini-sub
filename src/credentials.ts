/**
 * Credential storage and OAuth token lifecycle.
 *
 * Tokens are stored as a small JSON document in the user data directory so the
 * CLI helper and the OpenCode server can share one login. The file is created
 * with mode 0600. Existing Gemini CLI credentials are imported on first use,
 * which makes the plugin work without a second browser round-trip.
 */

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DATA_DIR_NAME, GEMINI_CLI_CREDENTIAL_PATHS, OAUTH_CLIENT_ENV } from "./constants.ts";

export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope?: string;
  tokenType?: string;
  clientId: string;
  clientSecret: string;
  email?: string;
}

export interface ProjectInfo {
  projectId: string;
  tierId?: string;
  tierName?: string;
  /** Whether the backend reported a paid subscription tier. */
  paid: boolean;
  /** Unix ms when this information was fetched. */
  fetchedAt: number;
}

export interface CredentialStore {
  version: 1;
  credentials?: OAuthCredentials;
  project?: ProjectInfo;
  /** Set by an explicit sign-out so the next start does not re-import the CLI login. */
  importDisabled?: boolean;
  updatedAt?: number;
}

const EMPTY_STORE: CredentialStore = { version: 1 };

/** `$XDG_DATA_HOME/opencode-gemini-sub` or `~/.local/share/opencode-gemini-sub`. */
export function dataDirectory(): string {
  const xdg = process.env["XDG_DATA_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
  return join(base, DATA_DIR_NAME);
}

export function storePath(): string {
  return join(dataDirectory(), "credentials.json");
}

export async function readStore(path = storePath()): Promise<CredentialStore> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as CredentialStore;
    if (parsed && typeof parsed === "object") return { ...EMPTY_STORE, ...parsed };
  } catch {
    // Missing or unreadable store: start clean. A corrupt store must never
    // prevent the server from booting.
  }
  return { ...EMPTY_STORE };
}

export async function writeStore(store: CredentialStore, path = storePath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const payload = JSON.stringify({ ...store, updatedAt: Date.now() }, null, 2);
  await writeFile(path, payload, { mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
}

export async function clearStore(path = storePath()): Promise<void> {
  await rm(path, { force: true });
}

interface GeminiCliCredentials {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
  client_id?: string;
  client_secret?: string;
}

function geminiCLIPaths(): string[] {
  const paths: string[] = [];
  const explicit = process.env["GEMINI_DIR"];
  if (explicit) paths.push(join(explicit, "oauth_creds.json"));
  for (const relative of GEMINI_CLI_CREDENTIAL_PATHS) {
    paths.push(join(homedir(), relative));
  }
  return [...new Set(paths)];
}

/**
 * Convert a Gemini CLI credential file into our store format.
 * Returns undefined when no usable file exists.
 */
export async function importGeminiCLICredentials(): Promise<OAuthCredentials | undefined> {
  for (const path of geminiCLIPaths()) {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as GeminiCliCredentials;
      if (!parsed.refresh_token) continue;
      return {
        accessToken: parsed.access_token ?? "",
        refreshToken: parsed.refresh_token,
        expiresAt: parsed.expiry_date ?? 0,
        scope: parsed.scope,
        tokenType: parsed.token_type ?? "Bearer",
        // The CLI file does not always carry a client id; fall back to the
        // OAuth application the token was issued to.
        clientId: parsed.client_id ?? "",
        clientSecret: parsed.client_secret ?? "",
        email: undefined,
      };
    } catch {
      // Try the next location.
    }
  }
  return undefined;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

/**
 * Single-flight credential manager. Every consumer shares one refresh promise,
 * so a burst of parallel sessions produces at most one token refresh.
 */
export class CredentialManager {
  #store: CredentialStore;
  #path: string;
  #refreshing: Promise<OAuthCredentials> | undefined;
  #loader: () => Promise<OAuthCredentials>;

  constructor(options: {
    path?: string;
    /** Supplies a fresh token when the store has none (used by tests). */
    loader?: () => Promise<OAuthCredentials>;
    store?: CredentialStore;
  } = {}) {
    this.#path = options.path ?? storePath();
    this.#store = options.store ?? { ...EMPTY_STORE };
    this.#loader =
      options.loader ??
      (async () => {
        throw new Error(
          "Not signed in. Run `/antigravity-login` (or `/gemini-login`), " +
            "or `opencode-gemini-sub login --profile antigravity` first.",
        );
      });
  }

  /** Load the store from disk and optionally import Gemini CLI credentials. */
  async bootstrap(options: { importGeminiCLI?: boolean } = {}): Promise<void> {
    this.#store = await readStore(this.#path);
    if (this.#store.credentials?.refreshToken) return;
    if (this.#store.importDisabled) return;
    if (options.importGeminiCLI === false) return;
    const imported = await importGeminiCLICredentials();
    if (!imported) return;
    this.#store = { ...this.#store, credentials: imported };
    await this.#save();
  }

  get store(): CredentialStore {
    return this.#store;
  }

  /** Absolute path of the credentials file. */
  get path(): string {
    return this.#path;
  }

  get credentials(): OAuthCredentials | undefined {
    return this.#store.credentials;
  }

  get project(): ProjectInfo | undefined {
    return this.#store.project;
  }

  get signedIn(): boolean {
    return Boolean(this.#store.credentials?.refreshToken);
  }

  async setCredentials(credentials: OAuthCredentials): Promise<void> {
    this.#store = { ...this.#store, credentials };
    await this.#save();
  }

  async setProject(project: ProjectInfo): Promise<void> {
    this.#store = { ...this.#store, project };
    await this.#save();
  }

  async clear(): Promise<void> {
    this.#store = { ...EMPTY_STORE };
    await clearStore(this.#path);
  }

  /**
   * Sign out but remember the decision. Without the tombstone the next start
   * would silently re-import `~/.gemini/oauth_creds.json`.
   */
  async signOut(): Promise<void> {
    this.#store = { version: 1, importDisabled: true };
    await this.#save();
  }

  /** Drop the cached access token but keep the refresh token. */
  async invalidate(): Promise<void> {
    const credentials = this.#store.credentials;
    if (!credentials) return;
    this.#store = {
      ...this.#store,
      credentials: { ...credentials, accessToken: "", expiresAt: 0 },
    };
    await this.#save();
  }

  /**
   * Return a valid access token, refreshing it 60 seconds before expiry.
   */
  async accessToken(now = Date.now()): Promise<string> {
    const credentials = await this.#current();
    if (credentials.accessToken && credentials.expiresAt - 60_000 > now) {
      return credentials.accessToken;
    }
    return (await this.refresh()).accessToken;
  }

  /** Force a refresh even if the cached token still looks valid. */
  async refresh(): Promise<OAuthCredentials> {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = this.#doRefresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #current(): Promise<OAuthCredentials> {
    const credentials = this.#store.credentials;
    if (credentials) return credentials;
    const loaded = await this.#loader();
    this.#store = { ...this.#store, credentials: loaded };
    await this.#save();
    return loaded;
  }

  async #doRefresh(): Promise<OAuthCredentials> {
    const credentials = await this.#current();
    if (!credentials.refreshToken) {
      throw new Error("Not signed in: no refresh token available.");
    }
    const body = new URLSearchParams({
      client_id:
        credentials.clientId ||
        process.env[OAUTH_CLIENT_ENV["gemini-cli"].id] ||
        "",
      client_secret:
        credentials.clientSecret ||
        process.env[OAUTH_CLIENT_ENV["gemini-cli"].secret] ||
        "",
      refresh_token: credentials.refreshToken,
      grant_type: "refresh_token",
    });
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      const text = await response.text();
      if (response.status === 400 || response.status === 401) {
        // The refresh token was revoked or expired: drop it so the next status
        // call tells the user to sign in again.
        this.#store = { ...this.#store, credentials: undefined };
        await this.#save();
        throw new Error(`Google rejected the refresh token (${response.status}): ${text}`);
      }
      throw new Error(`Token refresh failed (${response.status}): ${text}`);
    }
    const token = (await response.json()) as TokenResponse;
    const next: OAuthCredentials = {
      ...credentials,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? credentials.refreshToken,
      expiresAt: Date.now() + Math.max(0, token.expires_in - 30) * 1000,
      scope: token.scope ?? credentials.scope,
      tokenType: token.token_type ?? credentials.tokenType,
    };
    this.#store = { ...this.#store, credentials: next };
    await this.#save();
    return next;
  }

  async #save(): Promise<void> {
    await writeStore(this.#store, this.#path);
  }
}
