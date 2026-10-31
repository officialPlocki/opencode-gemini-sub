import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyError, parseDurationMs, parseProseDelayMs } from "../src/errors.ts";

const now = Date.UTC(2026, 0, 1, 12, 0, 0);

function body(details: unknown[], message = "Resource exhausted"): string {
  return JSON.stringify({ error: { code: 429, message, status: "RESOURCE_EXHAUSTED", details } });
}

const retryInfo = (delay: string) => ({
  "@type": "type.googleapis.com/google.rpc.RetryInfo",
  retryDelay: delay,
});
const quotaFailure = (quotaId: string) => ({
  "@type": "type.googleapis.com/google.rpc.QuotaFailure",
  violations: [{ quotaId }],
});

test("parses protobuf durations", () => {
  assert.equal(parseDurationMs("3.5s"), 3500);
  assert.equal(parseDurationMs("120s"), 120_000);
  assert.equal(parseDurationMs("250ms"), 250);
  assert.equal(parseDurationMs("2m"), 120_000);
  assert.equal(parseDurationMs("nonsense"), undefined);
});

test("parses prose retry hints", () => {
  assert.equal(parseProseDelayMs("Please retry in 27.4s"), 27_400);
  assert.equal(parseProseDelayMs("Your quota will reset after 3h 21m"), 3 * 3_600_000 + 21 * 60_000);
  assert.equal(parseProseDelayMs("available in 5 minutes"), 300_000);
});

test("classifies a short retry delay as rate limit", () => {
  const result = classifyError(429, {}, body([retryInfo("12s")]), now);
  assert.equal(result.kind, "rate-limit");
  assert.equal(result.terminal, false);
  assert.equal(result.resetAt, now + 12_000);
});

test("classifies a long retry delay as quota window", () => {
  const result = classifyError(429, {}, body([retryInfo("3600s")]), now);
  assert.equal(result.kind, "quota");
  assert.equal(result.resetAt, now + 3_600_000);
});

test("detects daily limits even without a delay", () => {
  const result = classifyError(429, {}, body([quotaFailure("GenerateRequestsPerDayPerProject")], "Quota exceeded"), now);
  assert.equal(result.kind, "quota");
  assert.equal(result.terminal, false);
});

test("treats spending caps as terminal", () => {
  const result = classifyError(400, {}, JSON.stringify({ error: { code: 400, message: "You reached your spending cap" } }), now);
  assert.equal(result.kind, "quota");
  assert.equal(result.terminal, true);
});

test("treats model capacity as retryable", () => {
  const result = classifyError(
    429,
    {},
    body([{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "MODEL_CAPACITY_EXHAUSTED" }]),
    now,
  );
  assert.equal(result.kind, "capacity");
  assert.equal(result.terminal, false);
});

test("401 becomes an auth error", () => {
  const result = classifyError(401, {}, "{}", now);
  assert.equal(result.kind, "auth");
  assert.equal(result.terminal, false);
});

test("honours the Retry-After header", () => {
  const result = classifyError(429, { "retry-after": "45" }, "", now);
  assert.equal(result.resetAt, now + 45_000);
});

test("falls back to a minute for bare 429s", () => {
  const result = classifyError(429, {}, "", now);
  assert.equal(result.kind, "rate-limit");
  assert.equal(result.resetAt, now + 60_000);
});
