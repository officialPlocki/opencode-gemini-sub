/**
 * Google OAuth for installed applications, loopback redirect variant.
 *
 * Flow: PKCE (S256) authorization code, callback on an ephemeral loopback
 * port, then a token exchange. This is the same flow a desktop CLI uses; the
 * only protocol-specific part is the client identity and scopes.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { OAUTH_AUTH_URL, OAUTH_SCOPES, OAUTH_TOKEN_URL, OAUTH_USERINFO_URL } from "./constants.ts";
import type { OAuthCredentials, TokenResponse } from "./credentials.ts";

export interface LoginOptions {
  clientId?: string;
  clientSecret?: string;
  /** OAuth scopes. Defaults to the Gemini CLI set. */
  scopes?: readonly string[];
  /** Loopback callback path. Defaults to `/oauth2callback`. */
  callbackPath?: string;
  /** Where to send the authorization URL; defaults to printing via logger. */
  onAuthUrl?: (url: string) => void;
  /** Open the URL in the default browser. Defaults to true. */
  openBrowser?: boolean;
  /** Abort the flow after this many milliseconds. Defaults to 5 minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

interface PendingCode {
  code: string;
}

function base64url(input: Buffer): string {
  return input.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function openInBrowser(url: string): void {
  const platform = process.platform;
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Headless environment; the URL is printed instead.
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("Could not determine the OAuth callback port"));
    });
  });
}

function waitForCode(
  server: Server,
  expectedState: string,
  callbackPath: string,
  signal?: AbortSignal,
): Promise<PendingCode> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      const reason = signal?.reason;
      reject(reason instanceof Error ? reason : new Error("Login cancelled"));
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      server.close();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== callbackPath) {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("Not found");
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        const description = url.searchParams.get("error_description") ?? "";
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end(`Authorization failed: ${error}\n${description}`);
        cleanup();
        reject(new Error(`Authorization failed: ${error} ${description}`.trim()));
        return;
      }
      if (url.searchParams.get("state") !== expectedState) {
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("State mismatch");
        cleanup();
        reject(new Error("OAuth state mismatch - possible CSRF, aborting"));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("Missing authorization code");
        cleanup();
        reject(new Error("No authorization code in callback"));
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<html><body style=\"font-family:system-ui;padding:2rem\">" +
          "<h2>Signed in</h2><p>You can close this tab and return to OpenCode.</p>" +
          "</body></html>",
      );
      cleanup();
      resolve({ code });
    });
  });
}

/** Exchange an authorization code for tokens. */
export async function exchangeCode(options: {
  code: string;
  verifier: string;
  redirectUri: string;
  clientId?: string;
  clientSecret?: string;
  fetchImpl?: typeof fetch;
}): Promise<TokenResponse> {
  if (!options.clientId || !options.clientSecret) {
    throw new Error(
      "OAuth client identity is missing. Set the profile's client id/secret via environment " +
        "variables or the plugin's `oauth` options (see README).",
    );
  }
  const body = new URLSearchParams({
    code: options.code,
    client_id: options.clientId,
    client_secret: options.clientSecret,
    redirect_uri: options.redirectUri,
    grant_type: "authorization_code",
    code_verifier: options.verifier,
  });
  const response = await (options.fetchImpl ?? fetch)(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as TokenResponse;
}

/** Fetch the email address that owns the token, for display only. */
export async function fetchAccountEmail(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(OAUTH_USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return undefined;
    const info = (await response.json()) as { email?: string };
    return info.email;
  } catch {
    return undefined;
  }
}

/**
 * Run the full interactive login. Resolves with credentials that are ready to
 * be persisted.
 */
export async function login(options: LoginOptions = {}): Promise<OAuthCredentials> {
  const clientId = options.clientId ?? "";
  const clientSecret = options.clientSecret ?? "";
  if (!clientId || !clientSecret) {
    throw new Error(
      "OAuth client identity is missing. Set the profile's client id/secret via environment " +
        "variables or the plugin's `oauth` options (see README).",
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const { verifier, challenge } = pkce();
  const state = base64url(randomBytes(32));
  const callbackPath = options.callbackPath ?? "/oauth2callback";
  const server = createServer();
  const port = await listen(server);
  const redirectUri = `http://127.0.0.1:${port}${callbackPath}`;

  const authUrl = new URL(OAUTH_AUTH_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", (options.scopes ?? OAUTH_SCOPES).join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  options.onAuthUrl?.(authUrl.toString());
  if (options.openBrowser !== false) openInBrowser(authUrl.toString());

  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () => timeoutController.abort(new Error("Login timed out")),
    options.timeoutMs ?? 5 * 60_000,
  );
  timeout.unref?.();
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const { code } = await waitForCode(server, state, callbackPath, signal);
    const token = await exchangeCode({
      code,
      verifier,
      redirectUri,
      clientId,
      clientSecret,
      fetchImpl,
    });
    const email = await fetchAccountEmail(token.access_token, fetchImpl);
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? "",
      expiresAt: Date.now() + Math.max(0, token.expires_in - 30) * 1000,
      scope: token.scope,
      tokenType: token.token_type ?? "Bearer",
      clientId,
      clientSecret,
      email,
    };
  } finally {
    clearTimeout(timeout);
    server.close();
  }
}
