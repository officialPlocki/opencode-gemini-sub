import assert from "node:assert/strict";
import { test } from "node:test";
import { type CodeAssistClient } from "../src/codeassist.ts";
import type { CredentialManager } from "../src/credentials.ts";
import { parseOptions } from "../src/options.ts";
import { sanitizeGeminiRequest, startProxy } from "../src/proxy.ts";

function fakeCredentials(): CredentialManager {
  return {
    signedIn: true,
    accessToken: async () => "token",
    refresh: async () => ({}),
    invalidate: async () => {},
  } as unknown as CredentialManager;
}

function sse(frames: unknown[], status = 200, headers: Record<string, string> = {}): Response {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join("");
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

function quotaError(delay: string, message = "Quota exceeded"): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 429,
        message,
        status: "RESOURCE_EXHAUSTED",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: delay }],
      },
    }),
    { status: 429, headers: { "content-type": "application/json" } },
  );
}

interface Recorded {
  envelope: Record<string, unknown>;
  url: string;
}

function fakeClient(handler: (call: number) => Response): { client: CodeAssistClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const client = {
    profile: { id: "gemini-cli", providerID: "gemini-sub", discovery: false },
    projectId: "test-project",
    sessionId: "session-1",
    requireProject: async () => "test-project",
    envelope: (input: { model: string; body: Record<string, unknown>; project?: string }) => ({
      model: input.model.replace(/^models\//, ""),
      project: input.project ?? "test-project",
      user_prompt_id: "prompt-1",
      request: { ...input.body, session_id: "session-1" },
    }),
    stream: async (envelope: Record<string, unknown>) => {
      calls.push({ envelope, url: "stream" });
      return handler(calls.length);
    },
    generate: async () => new Response(JSON.stringify({ response: { candidates: [] } }), { status: 200 }),
    countTokens: async () => ({ totalTokens: 7 }),
    retrieveUserQuota: async () => ({ buckets: [] }),
    quotaLimits: async () => [],
  } as unknown as CodeAssistClient;
  return { client, calls };
}

const options = (overrides: Record<string, unknown> = {}) =>
  parseOptions({ autoContinue: true, keepAliveMs: 1_000, debug: false, ...overrides });

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("mock mode streams a valid Gemini response", async () => {
  const { client } = fakeClient(() => sse([]));
  const proxy = await startProxy({
    client,
    credentials: fakeCredentials(),
    options: options({ mock: true }),
    log: () => {},
  });
  try {
    const response = await post(
      `${proxy.baseURL}/models/gemini-2.5-pro:streamGenerateContent?alt=sse`,
      { contents: [{ role: "user", parts: [{ text: "hello mock" }] }] },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await response.text();
    assert.match(text, /mock response from gemini-2\.5-pro: hello mock/);
    assert.match(text, /"finishReason":"STOP"/);
    assert.equal(proxy.state().completed, 1);
  } finally {
    await proxy.close();
  }
});

test("translates the Code Assist envelope into plain Gemini events", async () => {
  const { client, calls } = fakeClient(() =>
    sse([
      { response: { candidates: [{ content: { role: "model", parts: [{ text: "hi " }] } }] }, traceId: "t1" },
      { response: { candidates: [{ content: { role: "model", parts: [{ text: "there" }] }, finishReason: "STOP" }] } },
    ]),
  );
  const proxy = await startProxy({
    client,
    credentials: fakeCredentials(),
    options: options(),
    log: () => {},
  });
  try {
    const tools = [{ functionDeclarations: [{ name: "bash", description: "run", parametersJsonSchema: { type: "object" } }] }];
    const response = await post(
      `${proxy.baseURL}/models/gemini-2.5-pro:streamGenerateContent?alt=sse`,
      { model: "models/gemini-2.5-pro", contents: [], tools, systemInstruction: { parts: [{ text: "sys" }] } },
    );
    const text = await response.text();
    assert.doesNotMatch(text, /"response":/);
    assert.match(text, /"text":"hi "/);
    assert.match(text, /"finishReason":"STOP"/);

    const envelope = calls[0]?.envelope as {
      model: string;
      project: string;
      request: Record<string, unknown>;
      user_prompt_id: string;
    };
    assert.equal(envelope.model, "gemini-2.5-pro");
    assert.equal(envelope.project, "test-project");
    assert.deepEqual(envelope.request["tools"], tools);
    assert.deepEqual(envelope.request["systemInstruction"], { parts: [{ text: "sys" }] });
    assert.equal(envelope.request["model"], undefined);
    assert.equal(envelope.request["session_id"], "session-1");
    assert.ok(envelope.user_prompt_id);
  } finally {
    await proxy.close();
  }
});

test("parks a request on quota exhaustion and retries after the reset", async () => {
  const { client, calls } = fakeClient((call) =>
    call === 1
      ? quotaError("1s", "daily quota exhausted")
      : sse([{ response: { candidates: [{ content: { parts: [{ text: "after reset" }] }, finishReason: "STOP" }] } }]),
  );
  const proxy = await startProxy({
    client,
    credentials: fakeCredentials(),
    options: options({ keepAliveMs: 1_000 }),
    log: () => {},
  });
  try {
    const started = Date.now();
    const response = await post(
      `${proxy.baseURL}/models/gemini-2.5-pro:streamGenerateContent?alt=sse`,
      { contents: [{ role: "user", parts: [{ text: "continue" }] }] },
    );
    const text = await response.text();
    const elapsed = Date.now() - started;
    assert.match(text, /after reset/);
    assert.ok(elapsed >= 900, `expected to wait for the reset, took ${elapsed}ms`);
    assert.equal(calls.length, 2);
    assert.equal(proxy.state().quotaWaits, 1);
    const resetAt = proxy.state().lastResetAt;
    assert.ok(resetAt !== undefined && resetAt > started);
  } finally {
    await proxy.close();
  }
});

test("returns a terminal error when the reset is beyond maxQuotaWaitMs", async () => {
  const { client, calls } = fakeClient(() => quotaError("7200s"));
  const proxy = await startProxy({
    client,
    credentials: fakeCredentials(),
    options: options({ maxQuotaWaitMs: 1_000 }),
    log: () => {},
  });
  try {
    const response = await post(
      `${proxy.baseURL}/models/gemini-2.5-pro:streamGenerateContent?alt=sse`,
      { contents: [] },
    );
    const text = await response.text();
    assert.match(text, /"error"/);
    assert.match(text, /maxQuotaWaitMs/);
    assert.equal(calls.length, 1);
    assert.equal(proxy.state().failures, 1);
  } finally {
    await proxy.close();
  }
});

test("non-streaming generation unwraps the envelope", async () => {
  const { client } = fakeClient(() => sse([]));
  (client as unknown as { generate: () => Promise<Response> }).generate = async () =>
    new Response(JSON.stringify({ response: { candidates: [{ index: 0 }] }, traceId: "x" }), { status: 200 });
  const proxy = await startProxy({
    client,
    credentials: fakeCredentials(),
    options: options(),
    log: () => {},
  });
  try {
    const response = await post(`${proxy.baseURL}/models/gemini-2.5-pro:generateContent`, { contents: [] });
    assert.deepEqual(await response.json(), { candidates: [{ index: 0 }] });
  } finally {
    await proxy.close();
  }
});

test("countTokens proxies to the backend", async () => {
  const { client } = fakeClient(() => sse([]));
  const proxy = await startProxy({
    client,
    credentials: fakeCredentials(),
    options: options(),
    log: () => {},
  });
  try {
    const response = await post(`${proxy.baseURL}/models/gemini-2.5-pro:countTokens`, { contents: [] });
    assert.deepEqual(await response.json(), { totalTokens: 7 });
  } finally {
    await proxy.close();
  }
});

test("rejects unknown paths and wrong secrets", async () => {
  const { client } = fakeClient(() => sse([]));
  const proxy = await startProxy({
    client,
    credentials: fakeCredentials(),
    options: options(),
    log: () => {},
  });
  try {
    const wrong = await fetch(`http://127.0.0.1:${proxy.port}/nope/v1beta/models`);
    assert.equal(wrong.status, 404);
    const unknown = await post(`${proxy.baseURL}/models/../evil:generateContent`, {});
    assert.equal(unknown.status, 404);
  } finally {
    await proxy.close();
  }
});

test("mock mode honours the quota marker", async () => {
  const { client } = fakeClient(() => sse([]));
  const proxy = await startProxy({
    client,
    credentials: fakeCredentials(),
    options: options({ mock: true }),
    log: () => {},
  });
  try {
    const started = Date.now();
    const response = await post(
      `${proxy.baseURL}/models/gemini-2.5-pro:streamGenerateContent?alt=sse`,
      { contents: [{ role: "user", parts: [{ text: "[[quota:1]] hello" }] }] },
    );
    const text = await response.text();
    assert.match(text, /mock response/);
    assert.ok(Date.now() - started >= 900, "expected the mock to park the request");
    assert.equal(proxy.state().quotaWaits, 1);
    assert.equal(proxy.state().lastResetAt !== undefined, true);
  } finally {
    await proxy.close();
  }
});

test("sanitizes transport-only fields", () => {
  const body = sanitizeGeminiRequest({
    model: "models/gemini-2.5-pro",
    contents: [{ role: "user", parts: [{ text: "x" }] }],
    tools: [{ functionDeclarations: [] }],
    unknownField: true,
    generationConfig: { temperature: 0.2 },
  });
  assert.deepEqual(Object.keys(body).sort(), ["contents", "generationConfig", "tools"]);
});

test("builds CLI envelopes with session ids inside the request", async () => {
  const { CodeAssistClient } = await import("../src/codeassist.ts");
  const { createProfiles } = await import("../src/profiles.ts");
  const profile = createProfiles().find((entry) => entry.id === "gemini-cli");
  if (!profile) throw new Error("missing profile");
  const client = new CodeAssistClient({
    credentials: fakeCredentials(),
    profile,
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
  const envelope = client.envelope({ model: "models/gemini-2.5-pro", body: { contents: [] } });
  assert.equal(envelope["model"], "gemini-2.5-pro");
  assert.equal((envelope["request"] as Record<string, unknown>)["session_id"], client.sessionId);
  assert.equal(envelope["session_id"], undefined);
  assert.equal(typeof envelope["user_prompt_id"], "string");
});

test("builds Antigravity envelopes with requestId and userAgent", async () => {
  const { CodeAssistClient } = await import("../src/codeassist.ts");
  const { createProfiles } = await import("../src/profiles.ts");
  const profile = createProfiles().find((entry) => entry.id === "antigravity");
  if (!profile) throw new Error("missing profile");
  const client = new CodeAssistClient({
    credentials: fakeCredentials(),
    profile,
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
  const envelope = client.envelope({ model: "gemini-3-flash", body: { contents: [] } });
  assert.equal(envelope["model"], "gemini-3-flash");
  assert.equal(envelope["userAgent"], "antigravity");
  assert.equal(typeof envelope["requestId"], "string");
  assert.equal(envelope["user_prompt_id"], undefined);
  assert.equal(envelope["session_id"], undefined);
});
