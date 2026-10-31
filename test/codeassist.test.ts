import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodeAssistClient, projectID } from "../src/codeassist.ts";
import { CredentialManager } from "../src/credentials.ts";
import { createProfiles } from "../src/profiles.ts";

interface Call {
  url: string;
  body?: Record<string, unknown>;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function harness(routes: (call: Call, index: number) => Response | undefined) {
  const dir = await mkdtemp(join(tmpdir(), "gemini-sub-test-"));
  const credentials = new CredentialManager({
    path: join(dir, "credentials.json"),
    store: {
      version: 1,
      credentials: {
        accessToken: "test-token",
        refreshToken: "test-refresh",
        expiresAt: Date.now() + 3_600_000,
        clientId: "client",
        clientSecret: "secret",
      },
    },
  });
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const call = { url, body };
    calls.push(call);
    const response = routes(call, calls.length - 1);
    return response ?? json({ error: { code: 404, message: `unhandled ${url}` } }, 404);
  }) as typeof fetch;

  const profile = createProfiles().find((entry) => entry.id === "antigravity");
  if (!profile) throw new Error("missing antigravity profile");
  const client = new CodeAssistClient({
    credentials,
    profile,
    fetchImpl,
    pollIntervalMs: 1,
  });
  return { client, credentials, calls, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("projectID accepts strings and objects", () => {
  assert.equal(projectID("my-project"), "my-project");
  assert.equal(projectID({ id: "obj-project" }), "obj-project");
  assert.equal(projectID(undefined), undefined);
  assert.equal(projectID(""), undefined);
  assert.equal(projectID({}), undefined);
});

test("resolves the managed project returned by onboarding", async () => {
  const env = await harness((call) => {
    if (call.url.includes(":loadCodeAssist")) {
      return json({
        allowedTiers: [{ id: "free-tier", name: "Free", isDefault: true }],
      });
    }
    if (call.url.includes(":onboardUser")) {
      return json({ name: "operations/onboard-1", done: false });
    }
    if (call.url.includes("/operations/onboard-1")) {
      return json({ done: true, response: { cloudaicompanionProject: { id: "managed-123" } } });
    }
    return undefined;
  });
  try {
    const project = await env.client.ensureProject({ refresh: true });
    assert.equal(project.projectId, "managed-123");
    assert.equal(project.tierId, "free-tier");
    assert.equal(project.paid, false);
    // The onboarding request for the free tier omits the project.
    const onboard = env.calls.find((call) => call.url.includes(":onboardUser"));
    assert.equal(onboard?.body?.["tierId"], "free-tier");
    assert.equal(onboard?.body?.["cloudaicompanionProject"], undefined);
    // Project is persisted for the next start.
    assert.equal(env.credentials.project?.projectId, "managed-123");
  } finally {
    await env.cleanup();
  }
});

test("falls back to a second loadCodeAssist when onboarding returns no project", async () => {
  let loads = 0;
  const env = await harness((call) => {
    if (call.url.includes(":loadCodeAssist")) {
      loads += 1;
      if (loads === 1) {
        return json({
          allowedTiers: [{ id: "free-tier", isDefault: true }],
        });
      }
      return json({
        currentTier: { id: "free-tier", name: "Free" },
        cloudaicompanionProject: "late-project",
      });
    }
    if (call.url.includes(":onboardUser")) return json({ done: true, response: {} });
    return undefined;
  });
  try {
    const project = await env.client.ensureProject({ refresh: true });
    assert.equal(project.projectId, "late-project");
    assert.equal(loads, 2);
  } finally {
    await env.cleanup();
  }
});

test("onboards the standard tier with a user-supplied project", async () => {
  const env = await harness((call) => {
    if (call.url.includes(":loadCodeAssist")) {
      return json({
        allowedTiers: [
          { id: "standard-tier", name: "Gemini Code Assist", isDefault: true, userDefinedCloudaicompanionProject: true },
        ],
      });
    }
    if (call.url.includes(":onboardUser")) {
      return json({ done: true, response: {} });
    }
    return undefined;
  });
  try {
    const profile = createProfiles().find((entry) => entry.id === "antigravity");
    if (!profile) throw new Error("missing antigravity profile");
    const client = new CodeAssistClient({
      credentials: env.credentials,
      profile,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const call = {
          url: String(input),
          body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
        };
        env.calls.push(call);
        if (call.url.includes(":loadCodeAssist")) {
          return json({
            allowedTiers: [
              { id: "standard-tier", name: "Gemini Code Assist", isDefault: true, userDefinedCloudaicompanionProject: true },
            ],
          });
        }
        if (call.url.includes(":onboardUser")) return json({ done: true, response: {} });
        return json({ error: { code: 404, message: "unhandled" } }, 404);
      }) as typeof fetch,
      pollIntervalMs: 1,
      projectId: "my-project-123",
    });
    const project = await client.ensureProject({ refresh: true });
    assert.equal(project.projectId, "my-project-123");
    assert.equal(project.tierId, "standard-tier");
    assert.equal(project.paid, true);
    const onboard = env.calls.find((call) => call.url.includes(":onboardUser"));
    assert.equal(onboard?.body?.["tierId"], "standard-tier");
    assert.equal(onboard?.body?.["cloudaicompanionProject"], "my-project-123");
  } finally {
    await env.cleanup();
  }
});

test("reports an unsupported client before attempting onboarding", async () => {
  const env = await harness((call) => {
    if (call.url.includes(":loadCodeAssist")) {
      return json({
        allowedTiers: [{ id: "standard-tier", isDefault: true, userDefinedCloudaicompanionProject: true }],
        ineligibleTiers: [
          {
            tierId: "free-tier",
            reasonCode: "UNSUPPORTED_CLIENT",
            reasonMessage: "Please migrate to the Antigravity suite of products.",
          },
        ],
      });
    }
    return undefined;
  });
  try {
    await assert.rejects(
      () => env.client.ensureProject({ refresh: true }),
      (error: Error) => {
        assert.match(error.message, /UNSUPPORTED_CLIENT/);
        assert.match(error.message, /Antigravity/);
        assert.match(error.message, /GOOGLE_CLOUD_PROJECT/);
        return true;
      },
    );
    assert.equal(env.calls.some((call) => call.url.includes(":onboardUser")), false);
  } finally {
    await env.cleanup();
  }
});

test("explains the missing project with diagnostics", async () => {
  const env = await harness((call) => {
    if (call.url.includes(":loadCodeAssist")) {
      return json({
        currentTier: { id: "standard-tier", name: "Standard" },
        allowedTiers: [{ id: "standard-tier", isDefault: true }],
      });
    }
    if (call.url.includes(":onboardUser")) return json({ done: true, response: {} });
    return undefined;
  });
  try {
    await assert.rejects(
      () => env.client.ensureProject({ refresh: true }),
      (error: Error) => {
        assert.match(error.message, /no Cloud project/);
        assert.match(error.message, /GOOGLE_CLOUD_PROJECT/);
        assert.match(error.message, /Diagnostics:/);
        assert.match(error.message, /standard-tier/);
        return true;
      },
    );
  } finally {
    await env.cleanup();
  }
});


test("parses account-level 5h and weekly limits", async () => {
  const env = await harness((call) => {
    if (call.url.includes(":retrieveUserQuotaSummary")) {
      return json({
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              {
                bucketId: "gemini-weekly",
                displayName: "Weekly Limit Remaining",
                window: "weekly",
                resetTime: "2026-11-07T16:45:50Z",
                remainingFraction: 0.9,
              },
              {
                bucketId: "gemini-5h",
                displayName: "Five Hour Limit Remaining",
                window: "5h",
                resetTime: "2026-10-31T21:45:50Z",
                remainingFraction: 0.5,
              },
            ],
          },
          {
            displayName: "Claude and GPT models",
            buckets: [{ bucketId: "3p-5h", window: "5h", remainingFraction: 0.7 }],
          },
        ],
      });
    }
    return undefined;
  });
  try {
    const limits = await env.client.quotaLimits("test-project");
    assert.deepEqual(
      limits.map((limit) => `${limit.key}/${limit.window}/${limit.fraction}`),
      ["gemini/weekly/0.9", "gemini/5h/0.5", "3p/5h/0.7"],
    );
    assert.equal(limits[0]?.group, "Gemini Models");
  } finally {
    await env.cleanup();
  }
});

test("falls back to per-model quota when the summary is unavailable", async () => {
  const env = await harness((call) => {
    if (call.url.includes(":retrieveUserQuotaSummary")) {
      return json({ error: { code: 404, message: "not found" } }, 404);
    }
    if (call.url.includes(":fetchAvailableModels")) {
      return json({
        models: {
          "gemini-3-flash": { quotaInfo: { remainingFraction: 0.8, resetTime: "2026-10-31T21:00:00Z" } },
          "gemini-3.8-flash-low": { quotaInfo: { remainingFraction: 0.6, resetTime: "2026-10-31T21:00:00Z" } },
          "claude-sonnet-4-6": { quotaInfo: { remainingFraction: 0.4, resetTime: "2026-10-31T21:00:00Z" } },
        },
      });
    }
    return undefined;
  });
  try {
    const limits = await env.client.quotaLimits("test-project");
    assert.deepEqual(
      limits.map((limit) => `${limit.key}/${limit.window}/${limit.fraction}`),
      ["gemini/5h/0.6", "3p/5h/0.4"],
    );
  } finally {
    await env.cleanup();
  }
});
