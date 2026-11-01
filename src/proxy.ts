/**
 * Loopback HTTP server that speaks the Gemini REST API to OpenCode and the
 * Code Assist protocol to Google.
 *
 * OpenCode's Google provider is pointed at this server via `baseURL`, so the
 * normal Gemini request/response formats (including function calling, thought
 * signatures and multimodal parts) pass through unchanged. That is what gives
 * the plugin full tool support: there is no lossy translation layer.
 *
 * The server also owns the quota policy. When Google reports an exhausted
 * quota it parks the request, keeps the SSE connection alive, and retries at
 * the reset timestamp. From OpenCode's point of view the model simply took a
 * long time to answer, so the agent loop and all tool state survive.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { CodeAssistClient, stripModelsPrefix, type CodeAssistEnvelope } from "./codeassist.ts";
import type { CredentialManager } from "./credentials.ts";
import { classifyError, describeError, type ClassifiedError } from "./errors.ts";
import { delay, QuotaGate, Semaphore, type QuotaState } from "./gate.ts";
import { GEMINI_MODELS, findModel, mergeModels, normalizeModelID, type GeminiModel } from "./models.ts";
import type { PluginOptions } from "./options.ts";
import { SseUnwrapper, unwrapResponseBody } from "./sse.ts";

export interface ProxyState {
  signedIn: boolean;
  providerID: string;
  baseURL: string;
  autoContinue: boolean;
  quota: QuotaState;
  requests: number;
  completed: number;
  failures: number;
  quotaWaits: number;
  thoughts: number;
  lastError?: string;
  lastErrorAt?: number;
  lastResetAt?: number;
  models: number;
  startedAt: number;
}

export interface ProxyHandle {
  port: number;
  /** URL to use as the provider baseURL, including the secret path segment. */
  baseURL: string;
  secret: string;
  gate: QuotaGate;
  state(): ProxyState;
  close(): Promise<void>;
}

interface StartProxyOptions {
  client: CodeAssistClient;
  credentials: CredentialManager;
  options: PluginOptions;
  log?: (message: string) => void;
  /** Model catalogue, or a getter for a catalogue that changes at runtime. */
  models?: GeminiModel[] | (() => GeminiModel[]);
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendApiError(response: ServerResponse, status: number, message: string, details: unknown[] = []): void {
  sendJson(response, status, {
    error: { code: status, message, status: status === 429 ? "RESOURCE_EXHAUSTED" : "FAILED_PRECONDITION", details },
  });
}

async function readBody(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseBody(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object body");
  }
  return parsed as Record<string, unknown>;
}

/** Build a stable but unguessable path segment so only this provider can use the proxy. */
function makeSecret(): string {
  return createHash("sha256")
    .update(`${process.pid}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 24);
}

const PASSTHROUGH_PARTS = new Set(["contents", "systemInstruction", "tools", "toolConfig", "safetySettings", "generationConfig", "labels", "cachedContent", "serviceTier"]);

/**
 * Ask Gemini models for thought summaries. Claude and GPT-OSS reject the
 * Gemini `thinkingConfig` field, so it is only added to Gemini models that the
 * catalogue marks as thinking-capable.
 */
export function withThoughts(
  body: Record<string, unknown>,
  modelID: string,
  models: readonly GeminiModel[],
  enabled: boolean,
): Record<string, unknown> {
  if (!enabled) return body;
  const id = normalizeModelID(modelID);
  if (!/^gemini/i.test(id)) return body;
  const model = models.find((entry) => entry.id === id);
  if (model && model.thinking === false) return body;

  const generationConfig = { ...((body["generationConfig"] as Record<string, unknown> | undefined) ?? {}) };
  const thinkingConfig = { ...((generationConfig["thinkingConfig"] as Record<string, unknown> | undefined) ?? {}) };
  // Force it: some clients send `includeThoughts: false` by default, which
  // would suppress the thought text even though the user wants it.
  thinkingConfig["includeThoughts"] = true;
  generationConfig["thinkingConfig"] = thinkingConfig;
  return { ...body, generationConfig };
}

/** Remove transport-only fields and anything the backend would reject. */
export function sanitizeGeminiRequest(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (PASSTHROUGH_PARTS.has(key)) out[key] = value;
  }
  // The REST API allows `model` in the body; Code Assist takes it at the top
  // level instead, so it is deliberately dropped here.
  return out;
}

/** Concatenate every user text in the request (marker detection). */
function allPromptText(request: Record<string, unknown>): string {
  const contents = Array.isArray(request["contents"]) ? request["contents"] : [];
  return contents
    .map((content) => content as { role?: string; parts?: { text?: string }[] })
    .filter((content) => content.role === "user")
    .flatMap((content) => content.parts ?? [])
    .map((part) => part.text ?? "")
    .join("\n");
}

/** Extract the most recent user text from a Gemini request body. */
function firstPromptText(request: Record<string, unknown>): string {
  const contents = Array.isArray(request["contents"]) ? request["contents"] : [];
  for (let index = contents.length - 1; index >= 0; index -= 1) {
    const content = contents[index] as { role?: string; parts?: { text?: string }[] } | undefined;
    if (content?.role !== "user") continue;
    return (content.parts ?? []).map((part) => part.text ?? "").join(" ");
  }
  return "";
}

/** Mock upstream used by `options.mock` and by the test suite. */
function mockChunks(model: string, body: Record<string, unknown>): unknown[] {
  const contents = Array.isArray(body["contents"]) ? body["contents"] : [];
  const last = contents.at(-1) as { role?: string; parts?: { text?: string; functionResponse?: unknown }[] } | undefined;
  const parts = last?.parts ?? [];
  const prompt = parts.map((part) => part.text ?? "").join(" ");
  const allText = allPromptText(body);
  const promptTokens = Math.max(1, Math.ceil(prompt.length / 4));

  const usage = {
    promptTokenCount: promptTokens,
    candidatesTokenCount: 1,
    totalTokenCount: promptTokens + 1,
  };

  // A function response means the agent loop already executed a tool; answer
  // with text so the mock conversation terminates.
  if (parts.some((part) => part.functionResponse !== undefined)) {
    return [
      {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "tool result received" }] },
            finishReason: "STOP",
            index: 0,
          },
        ],
        usageMetadata: usage,
        modelVersion: model,
      },
    ];
  }

  // `[[tool:name:{json}]]` lets an end-to-end test exercise real tool calling
  // without a Google account.
  const tool = /\[\[tool:([A-Za-z0-9_.-]+):(.+?)\]\]/s.exec(allText);
  if (tool) {
    let args: unknown = {};
    try {
      args = JSON.parse(tool[2] ?? "{}");
    } catch {
      args = {};
    }
    return [
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: tool[1], args } }],
            },
            finishReason: "STOP",
            index: 0,
          },
        ],
        usageMetadata: usage,
        modelVersion: model,
      },
    ];
  }

  const tools = Array.isArray(body["tools"]) ? body["tools"] : [];
  const toolNames = tools
    .flatMap((entry) => (entry && typeof entry === "object" ? (entry as { functionDeclarations?: { name?: string }[] }).functionDeclarations ?? [] : []))
    .map((declaration) => declaration.name)
    .filter(Boolean);

  const text = `mock response from ${model}: ${prompt.slice(0, 120) || "(empty prompt)"}${
    toolNames.length ? ` [tools: ${toolNames.join(", ")}]` : " [tools: none]"
  }`;
  return [
    {
      candidates: [
        {
          content: { role: "model", parts: [{ text }] },
          index: 0,
        },
      ],
      usageMetadata: usage,
      modelVersion: model,
    },
    {
      candidates: [
        {
          content: { role: "model", parts: [] },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: usage,
      modelVersion: model,
    },
  ];
}

export async function startProxy(options: StartProxyOptions): Promise<ProxyHandle> {
  const { client, credentials, options: config } = options;
  const log = options.log ?? ((message: string) => console.error(`[gemini-sub] ${message}`));
  const modelSource = options.models ?? mergeModels(config.models);
  const listModels: () => GeminiModel[] = typeof modelSource === "function" ? modelSource : () => modelSource;
  const gate = new QuotaGate();
  const semaphore = new Semaphore(config.concurrency);
  const secret = makeSecret();

  const stats = {
    requests: 0,
    completed: 0,
    failures: 0,
    quotaWaits: 0,
    thoughts: 0,
    startedAt: Date.now(),
    lastError: undefined as string | undefined,
    lastErrorAt: undefined as number | undefined,
    lastResetAt: undefined as number | undefined,
  };

  const debug = (message: string) => {
    if (config.debug) log(message);
  };

  /** Determine when a blocked request may continue. */
  async function resolveReset(error: ClassifiedError, project?: string): Promise<number> {
    const now = Date.now();
    let until: number | undefined;
    if (error.resetAt && error.resetAt > now) until = error.resetAt + 2_000;
    else if (error.retryAfterMs && error.retryAfterMs > 0 && error.retryAfterMs < 10 * 60_000) {
      until = now + error.retryAfterMs + 1_000;
    }
    if (until === undefined) {
      try {
        const limits = await client.quotaLimits(project);
        const exhausted = limits.filter((limit) => limit.fraction >= 0 && limit.fraction <= 0.0001);
        // Prefer the window that is actually empty; otherwise the 5h window is
        // the one a normal rate limit refers to. Only then consider weekly.
        const pool = exhausted.length > 0 ? exhausted : limits.filter((limit) => limit.window === "5h");
        const candidates = (pool.length > 0 ? pool : limits)
          .map((limit) => (limit.resetTime ? Date.parse(limit.resetTime) : Number.NaN))
          .filter((value) => Number.isFinite(value) && value > now)
          .sort((a, b) => a - b);
        if (candidates[0] !== undefined) until = candidates[0] + 15_000;
      } catch (cause) {
        debug(`quota lookup failed: ${String(cause)}`);
      }
    }
    if (until === undefined) {
      until = now + (error.retryAfterMs && error.retryAfterMs > 0 ? error.retryAfterMs : 60_000) + 10_000;
    }
    // Never wake early enough to hammer the backend in a tight loop.
    return Math.max(until, now + 5_000);
  }

  function write(response: ServerResponse, chunk: string): boolean {
    try {
      return response.write(chunk);
    } catch {
      return false;
    }
  }

  function streamError(response: ServerResponse, error: ClassifiedError): void {
    stats.lastError = describeError(error);
    stats.lastErrorAt = Date.now();
    if (error.resetAt) stats.lastResetAt = error.resetAt;
    // Headers are already sent at this point, so this is the best effort the
    // SSE protocol allows: a final event carrying a Gemini-shaped error.
    const status = error.status === 429 ? "RESOURCE_EXHAUSTED" : error.status === 401 || error.status === 403 ? "UNAUTHENTICATED" : "INTERNAL";
    write(
      response,
      `data: ${JSON.stringify({
        error: { code: error.status, message: error.message, status, details: error.details },
      })}\n\n`,
    );
    log(`request failed: ${describeError(error)}`);
  }

  async function streamOnce(
    response: ServerResponse,
    envelope: CodeAssistEnvelope,
    model: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (config.mock) {
      const text = allPromptText(envelope.request as Record<string, unknown>);
      const marker = /\[\[quota:([0-9]+)\]\]/.exec(text);
      if (marker) {
        const until = Date.now() + Number(marker[1] ?? 0) * 1000;
        gate.block(until, "mock quota window");
        stats.quotaWaits += 1;
        stats.lastResetAt = until;
        log(`mock quota: parking until ${new Date(until).toISOString()}`);
        await gate.wait(signal);
      }
      for (const chunk of mockChunks(model, envelope.request as Record<string, unknown>)) {
        if (signal.aborted) return;
        write(response, `data: ${JSON.stringify(chunk)}\n\n`);
        await delay(10, signal);
      }
      stats.completed += 1;
      return;
    }

    let authAttempts = 0;
    let serverAttempts = 0;

    for (;;) {
      await gate.wait(signal);
      const release = await semaphore.acquire(signal);
      let upstream: Response;
      try {
        upstream = await client.stream(envelope, { signal });
      } finally {
        release();
      }

      if (upstream.ok && upstream.body) {
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        const unwrapper = new SseUnwrapper();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (signal.aborted) {
              await reader.cancel().catch(() => {});
              return;
            }
            for (const frame of unwrapper.push(decoder.decode(value, { stream: true }))) {
              if (frame.includes('"thought":true')) stats.thoughts += 1;
              if (!write(response, frame)) {
                await reader.cancel().catch(() => {});
                return;
              }
            }
          }
          for (const frame of unwrapper.flush()) write(response, frame);
        } finally {
          reader.releaseLock();
        }
        stats.completed += 1;
        return;
      }

      const text = await upstream.text();
      const classified = classifyError(upstream.status, upstream.headers, text);
      debug(`upstream ${upstream.status}: ${describeError(classified)}`);

      if (classified.kind === "auth" && authAttempts < 2) {
        authAttempts += 1;
        await credentials.invalidate().catch(() => {});
        await credentials.refresh().catch((cause) => log(`token refresh failed: ${String(cause)}`));
        continue;
      }

      if (
        config.autoContinue &&
        !classified.terminal &&
        (classified.kind === "quota" || classified.kind === "rate-limit" || classified.kind === "capacity")
      ) {
        const until = await resolveReset(classified, client.projectId);
        const waitMs = until - Date.now();
        if (config.maxQuotaWaitMs > 0 && waitMs > config.maxQuotaWaitMs) {
          streamError(response, {
            ...classified,
            message:
              `${classified.message}\n\nThe quota resets at ${new Date(until).toISOString()}, ` +
              `which is later than maxQuotaWaitMs (${Math.round(config.maxQuotaWaitMs / 60_000)} min). ` +
              `Increase maxQuotaWaitMs or retry manually.`,
            resetAt: until,
          });
          stats.failures += 1;
          return;
        }
        gate.block(until, classified.message);
        stats.quotaWaits += 1;
        stats.lastResetAt = until;
        log(
          `quota exhausted (${classified.kind}); parking request until ${new Date(until).toISOString()} ` +
            `(${Math.round(waitMs / 1000)}s)`,
        );
        continue;
      }

      if (classified.kind === "server" && serverAttempts < 3) {
        serverAttempts += 1;
        await delay(Math.min(30_000, 1000 * 2 ** serverAttempts), signal);
        continue;
      }

      streamError(response, classified);
      stats.failures += 1;
      return;
    }
  }

  async function handleStream(
    request: IncomingMessage,
    response: ServerResponse,
    modelID: string,
  ): Promise<void> {
    stats.requests += 1;
    const raw = await readBody(request);
    const body = withThoughts(
      sanitizeGeminiRequest(parseBody(raw)),
      modelID,
      listModels(),
      config.includeThoughts,
    );

    // Resolve the account before sending SSE headers so an unauthenticated
    // request gets a readable HTTP error instead of a silent empty stream.
    if (!config.mock) {
      try {
        await client.requireProject();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const status = /not signed in|refresh token|unauthor/i.test(message) ? 401 : 502;
        sendApiError(response, status, message);
        stats.failures += 1;
        return;
      }
    }

    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const controller = new AbortController();
    response.on("close", () => controller.abort());

    const keepAlive = setInterval(() => {
      if (!response.writableEnded) write(response, `: keep-alive ${new Date().toISOString()}\n\n`);
    }, config.keepAliveMs);
    keepAlive.unref?.();

    try {
      const envelope = client.envelope({
        model: normalizeModelID(modelID),
        body,
        project: config.projectId ?? client.projectId,
      });
      await streamOnce(response, envelope, normalizeModelID(modelID), controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted) {
        const message = cause instanceof Error ? cause.message : String(cause);
        log(`stream failed: ${message}`);
        stats.failures += 1;
        write(response, `data: ${JSON.stringify({ error: { code: 500, message, status: "INTERNAL" } })}\n\n`);
      }
    } finally {
      clearInterval(keepAlive);
      if (!response.writableEnded) response.end();
    }
  }

  async function handleGenerate(
    request: IncomingMessage,
    response: ServerResponse,
    modelID: string,
  ): Promise<void> {
    stats.requests += 1;
    const raw = await readBody(request);
    const body = withThoughts(
      sanitizeGeminiRequest(parseBody(raw)),
      modelID,
      listModels(),
      config.includeThoughts,
    );

    if (config.mock) {
      const chunks = mockChunks(normalizeModelID(modelID), body);
      sendJson(response, 200, { ...(chunks[0] as object), ...(chunks[1] as object) });
      stats.completed += 1;
      return;
    }

    const controller = new AbortController();
    response.on("close", () => controller.abort());

    if (!config.mock) {
      try {
        await client.requireProject();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const status = /not signed in|refresh token|unauthor/i.test(message) ? 401 : 502;
        sendApiError(response, status, message);
        stats.failures += 1;
        return;
      }
    }

    const envelope = client.envelope({
      model: normalizeModelID(modelID),
      body,
      project: config.projectId ?? client.projectId,
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await gate.wait(controller.signal);
      const upstream = await client.generate(envelope, { signal: controller.signal });
      if (upstream.ok) {
        const payload = unwrapResponseBody(await upstream.json());
        sendJson(response, 200, payload);
        stats.completed += 1;
        return;
      }
      const text = await upstream.text();
      const classified = classifyError(upstream.status, upstream.headers, text);
      if (
        config.autoContinue &&
        !classified.terminal &&
        (classified.kind === "quota" || classified.kind === "rate-limit" || classified.kind === "capacity")
      ) {
        const until = await resolveReset(classified, client.projectId);
        gate.block(until, classified.message);
        stats.quotaWaits += 1;
        continue;
      }
      stats.failures += 1;
      sendApiError(response, classified.status, classified.message, classified.details);
      return;
    }
    stats.failures += 1;
    sendApiError(response, 429, "Quota exhausted; retries did not succeed.");
  }

  async function handleCountTokens(
    request: IncomingMessage,
    response: ServerResponse,
    modelID: string,
  ): Promise<void> {
    const body = parseBody(await readBody(request));
    const contents = body["contents"] ?? [];
    try {
      const result = await client.countTokens({ model: normalizeModelID(modelID), contents });
      sendJson(response, 200, { totalTokens: result.totalTokens ?? 0 });
    } catch (cause) {
      sendApiError(response, 502, cause instanceof Error ? cause.message : String(cause));
    }
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const prefix = `/${secret}`;
      if (!url.pathname.startsWith(prefix)) {
        sendJson(response, 404, { error: { code: 404, message: "Not found" } });
        return;
      }
      const path = url.pathname.slice(prefix.length);

      if (path === "/health" || path === "/status") {
        sendJson(response, 200, snapshot());
        return;
      }

      if (path === "/v1beta/models" && request.method === "GET") {
        sendJson(response, 200, {
          models: listModels().map((model) => ({
            name: `models/${model.id}`,
            displayName: model.name,
            description: `Subscription-backed ${model.name}`,
            inputTokenLimit: model.context,
            outputTokenLimit: model.output,
            supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"],
          })),
        });
        return;
      }

      const match = /^\/v1beta\/models\/(.+?):([A-Za-z]+)$/.exec(path);
      if (!match) {
        sendJson(response, 404, { error: { code: 404, message: `Unknown path ${path}` } });
        return;
      }
      const rawModel = decodeURIComponent(match[1] ?? "");
      const method = match[2];
      const modelID = normalizeModelID(rawModel);

      if (!config.mock && !findModel(modelID) && !listModels().some((model) => model.id === modelID)) {
        sendApiError(response, 404, `Unknown model ${modelID}`);
        return;
      }

      if (request.method !== "POST") {
        sendApiError(response, 405, "Use POST");
        return;
      }

      switch (method) {
        case "streamGenerateContent":
          await handleStream(request, response, modelID);
          return;
        case "generateContent":
          await handleGenerate(request, response, modelID);
          return;
        case "countTokens":
          await handleCountTokens(request, response, modelID);
          return;
        default:
          sendApiError(response, 404, `Unsupported method ${method}`);
      }
    })().catch((cause) => {
      if (!response.headersSent) sendApiError(response, 502, cause instanceof Error ? cause.message : String(cause));
      else if (!response.writableEnded) response.end();
    });
  });

  function snapshot(): ProxyState {
    return {
      signedIn: credentials.signedIn,
      providerID: client.profile?.providerID ?? "unknown",
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo | null)?.port ?? 0}/${secret}/v1beta`,
      autoContinue: config.autoContinue,
      quota: gate.state(),
      requests: stats.requests,
      completed: stats.completed,
      failures: stats.failures,
      quotaWaits: stats.quotaWaits,
      thoughts: stats.thoughts,
      lastError: stats.lastError,
      lastErrorAt: stats.lastErrorAt,
      lastResetAt: stats.lastResetAt,
      models: listModels().length,
      startedAt: stats.startedAt,
    };
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const baseURL = `http://127.0.0.1:${address.port}/${secret}/v1beta`;
  log(`proxy listening on ${baseURL} (${listModels().length} models, autoContinue=${config.autoContinue})`);

  return {
    port: address.port,
    baseURL,
    secret,
    gate,
    state: snapshot,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Re-exported for tests and status rendering. */
export { GEMINI_MODELS, stripModelsPrefix };
