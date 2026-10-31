import assert from "node:assert/strict";
import { test } from "node:test";
import { SseUnwrapper, unwrapEvent, unwrapResponseBody } from "../src/sse.ts";

test("unwraps a simple response event", () => {
  const unwrapper = new SseUnwrapper();
  const frames = unwrapper.push(
    'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]}}]},"traceId":"t"}\n\n',
  );
  assert.equal(frames.length, 1);
  assert.deepEqual(JSON.parse(frames[0]!.slice(6)), {
    candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }],
  });
});

test("survives arbitrary chunk boundaries and CRLF", () => {
  const payload =
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"a"},{"text":"b"}]}}]}}\r\n\r\n';
  const unwrapper = new SseUnwrapper();
  const frames = [];
  for (const char of payload) frames.push(...unwrapper.push(char));
  assert.equal(frames.length, 1);
  const parsed = JSON.parse(frames[0]!.slice(6));
  assert.equal(parsed.candidates[0].content.parts.length, 2);
});

test("joins multi-line data blocks", () => {
  const unwrapper = new SseUnwrapper();
  const frames = unwrapper.push('data: {"response":\ndata: {"candidates":[]}}\n\n');
  assert.equal(frames.length, 1);
  assert.deepEqual(JSON.parse(frames[0]!.slice(6)), { candidates: [] });
});

test("ignores comments and keep-alives", () => {
  const unwrapper = new SseUnwrapper();
  assert.deepEqual(unwrapper.push(": keep-alive 2026-01-01T00:00:00Z\n\n"), []);
  assert.deepEqual(unwrapper.push("event: ping\n\n"), []);
});

test("passes upstream error objects through", () => {
  const unwrapper = new SseUnwrapper();
  const frames = unwrapper.push('data: {"error":{"code":429,"message":"nope"}}\n\n');
  assert.match(frames[0]!, /"code":429/);
});

test("flushes a trailing event without a blank line", () => {
  const unwrapper = new SseUnwrapper();
  assert.deepEqual(unwrapper.push('data: {"response":{"candidates":[]}}'), []);
  const frames = unwrapper.flush();
  assert.equal(frames.length, 1);
  assert.deepEqual(JSON.parse(frames[0]!.slice(6)), { candidates: [] });
});

test("tolerates the bare GenerateContentResponse shape", () => {
  const { payload } = unwrapEvent({ candidates: [{ index: 0 }] });
  assert.deepEqual(payload, { candidates: [{ index: 0 }] });
});

test("unwraps non-streaming bodies", () => {
  assert.deepEqual(unwrapResponseBody({ response: { candidates: [] }, traceId: "x" }), { candidates: [] });
  assert.deepEqual(unwrapResponseBody({ candidates: [] }), { candidates: [] });
  assert.deepEqual(unwrapResponseBody({ response: null }), {});
});
