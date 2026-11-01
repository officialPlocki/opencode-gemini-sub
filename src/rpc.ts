/**
 * RPC contract between the server part and the TUI part.
 *
 * The TUI polls `status` to render the sidebar panel: quota fractions, reset
 * times, and whether the proxy is currently parked waiting for a quota window.
 */

import { Rpc } from "@opencode/plugin/rpc";

export interface LimitRow {
  /** Pool key: `gemini`, `3p`, or a custom slug. */
  key: string;
  group: string;
  /** `5h`, `weekly`, or a raw backend value. */
  window: string;
  /** 0..1, or -1 when the backend did not report a fraction. */
  fraction: number;
  /** ISO timestamp, empty when unknown. */
  resetTime: string;
}

export interface ProfileStatus {
  id: string;
  name: string;
  providerID: string;
  signedIn: boolean;
  account: string;
  project: string;
  tier: string;
  autoContinue: boolean;
  /** Epoch ms until which requests are parked, 0 when open. */
  blockedUntil: number;
  waiting: number;
  requests: number;
  completed: number;
  failures: number;
  quotaWaits: number;
  lastError: string;
  limits: LimitRow[];
  unavailable: { name: string; reason: string }[];
}

export interface StatusPayload {
  generatedAt: number;
  profiles: ProfileStatus[];
}

export interface StatsPayload {
  turns: number;
  steps: number;
  outputTokens: number;
  tokensPerSecond: number;
}

const limitRow = {
  type: "object",
  properties: {
    key: { type: "string" },
    group: { type: "string" },
    window: { type: "string" },
    fraction: { type: "number" },
    resetTime: { type: "string" },
  },
  required: ["key", "group", "window", "fraction", "resetTime"],
  additionalProperties: false,
} as const;

export const GeminiSubRpc = Rpc.define({
  id: "gemini-sub",
  methods: {
    stats: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          turns: { type: "number" },
          steps: { type: "number" },
          outputTokens: { type: "number" },
          tokensPerSecond: { type: "number" },
        },
        required: ["turns", "steps", "outputTokens", "tokensPerSecond"],
        additionalProperties: false,
      },
    },
    status: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          generatedAt: { type: "number" },
          profiles: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                providerID: { type: "string" },
                signedIn: { type: "boolean" },
                account: { type: "string" },
                project: { type: "string" },
                tier: { type: "string" },
                autoContinue: { type: "boolean" },
                blockedUntil: { type: "number" },
                waiting: { type: "number" },
                requests: { type: "number" },
                completed: { type: "number" },
                failures: { type: "number" },
                quotaWaits: { type: "number" },
                lastError: { type: "string" },
                limits: { type: "array", items: limitRow },
                unavailable: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      reason: { type: "string" },
                    },
                    required: ["name", "reason"],
                    additionalProperties: false,
                  },
                },
              },
              required: [
                "id",
                "name",
                "providerID",
                "signedIn",
                "account",
                "project",
                "tier",
                "autoContinue",
                "blockedUntil",
                "waiting",
                "requests",
                "completed",
                "failures",
                "quotaWaits",
                "lastError",
                "limits",
                "unavailable",
              ],
              additionalProperties: false,
            },
          },
        },
        required: ["generatedAt", "profiles"],
        additionalProperties: false,
      },
    },
  },
  events: {},
} as const);
