import assert from "node:assert/strict";
import { test } from "node:test";
import { computeSessionStats } from "../src/stats.ts";

test("counts turns and steps and computes tokens/s from step durations", () => {
  const stats = computeSessionStats([
    { type: "user" },
    {
      type: "assistant",
      tokens: { output: 100, reasoning: 20 },
      time: { created: 0, completed: 2_000 },
    },
    { type: "user" },
    {
      type: "assistant",
      tokens: { output: 80, reasoning: 0 },
      time: { created: 2_000, completed: 3_000 },
    },
  ]);
  assert.equal(stats.turns, 2);
  assert.equal(stats.steps, 2);
  assert.equal(stats.outputTokens, 200);
  // 200 tokens over 3 seconds.
  assert.ok(Math.abs(stats.tokensPerSecond - 66.666) < 0.01);
});

test("accepts ISO timestamps and ignores incomplete steps for throughput", () => {
  const stats = computeSessionStats([
    {
      type: "assistant",
      tokens: { output: 40 },
      time: { created: "2026-01-01T00:00:00.000Z", completed: "2026-01-01T00:00:01.000Z" },
    },
    { type: "assistant", tokens: { output: 60 }, time: { created: "2026-01-01T00:00:01.000Z" } },
  ]);
  assert.equal(stats.steps, 2);
  assert.equal(stats.outputTokens, 100);
  assert.equal(stats.tokensPerSecond, 40);
});

test("handles an empty or missing message list", () => {
  assert.deepEqual(computeSessionStats(undefined), {
    turns: 0,
    steps: 0,
    outputTokens: 0,
    tokensPerSecond: 0,
  });
  assert.equal(computeSessionStats([]).steps, 0);
});
