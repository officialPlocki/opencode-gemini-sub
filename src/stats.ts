/**
 * Session statistics derived from OpenCode's message list.
 *
 * A "turn" is a user message, a "step" is one assistant step (model call).
 * Throughput uses the completed step durations, so time spent waiting for
 * tools or for the user does not dilute tokens/s.
 */

export interface StatsMessage {
  type?: string;
  tokens?: { output?: number; reasoning?: number };
  time?: { created?: string | number | Date; completed?: string | number | Date };
}

export interface SessionStats {
  turns: number;
  steps: number;
  outputTokens: number;
  tokensPerSecond: number;
}

function toMillis(value: string | number | Date | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function computeSessionStats(messages: readonly StatsMessage[] | undefined): SessionStats {
  let turns = 0;
  let steps = 0;
  let outputTokens = 0;
  let timedOutputTokens = 0;
  let durationMs = 0;

  for (const message of messages ?? []) {
    if (message?.type === "user") {
      turns += 1;
      continue;
    }
    if (message?.type !== "assistant") continue;

    steps += 1;
    const tokens = (message.tokens?.output ?? 0) + (message.tokens?.reasoning ?? 0);
    outputTokens += tokens;
    const start = toMillis(message.time?.created);
    const end = toMillis(message.time?.completed);
    if (start !== undefined && end !== undefined && end > start) {
      durationMs += end - start;
      // Only completed steps contribute to throughput; an in-flight step has
      // tokens but no duration yet.
      timedOutputTokens += tokens;
    }
  }

  return {
    turns,
    steps,
    outputTokens,
    tokensPerSecond: durationMs > 0 ? timedOutputTokens / (durationMs / 1000) : 0,
  };
}
