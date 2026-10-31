/**
 * OpenCode V2 plugin entrypoint.
 *
 * Each enabled profile (Antigravity, Gemini CLI) gets its own credential store,
 * Code Assist client and loopback proxy. The proxies are registered as ordinary
 * Google providers, so OpenCode's native Gemini protocol and tool calling are
 * preserved end to end.
 */

import { join } from "node:path";
import { Model, Plugin, Provider } from "@opencode/plugin";
import {
  CodeAssistClient,
  type AvailableModelInfo,
  type AvailableModelsResponse,
  type QuotaLimit,
} from "./codeassist.ts";
import { OAUTH_CLIENT_ENV } from "./constants.ts";
import { CredentialManager, dataDirectory } from "./credentials.ts";
import { mergeModels, type GeminiModel } from "./models.ts";
import { login } from "./oauth.ts";
import { parseOptions } from "./options.ts";
import { createProfiles, type Profile } from "./profiles.ts";
import { startProxy, type ProxyHandle } from "./proxy.ts";
import { GeminiSubRpc, type ProfileStatus, type StatusPayload } from "./rpc.ts";

type CommandContext = { sessionID: string; prompt?: { text?: string } };

interface Runtime {
  profile: Profile;
  credentials: CredentialManager;
  client: CodeAssistClient;
  proxy: ProxyHandle;
  catalog: { models: GeminiModel[] };
  unavailable: { name: string; reason: string }[];
  limits: QuotaLimit[];
  quotaFetchedAt: number;
  quotaInFlight: boolean;
  loginInFlight: boolean;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function familyOf(id: string): string {
  if (id.startsWith("claude")) return "claude";
  if (id.startsWith("gpt-oss")) return "gpt-oss";
  if (id.startsWith("gemini-2.5")) return "gemini-2.5";
  if (id.startsWith("gemini-3")) return "gemini-3";
  if (id.startsWith("gemma")) return "gemma";
  return "custom";
}

function fallbackModel(id: string): GeminiModel {
  const isClaude = id.startsWith("claude");
  const isOss = id.startsWith("gpt-oss");
  return {
    id,
    name: id,
    family: familyOf(id),
    released: "2026-01-01",
    context: isClaude ? 200_000 : isOss ? 131_072 : 1_048_576,
    output: isClaude ? 64_000 : isOss ? 32_768 : 65_536,
    tools: true,
    multimodal: !isOss,
    thinking: isClaude || id.includes("thinking"),
    freeTier: false,
  };
}

/**
 * Turn `fetchAvailableModels` into the plugin catalogue. The backend is the
 * authority: ids, display names, limits and image support come from it.
 */
export function modelsFromInventory(
  inventory: AvailableModelsResponse,
  fallback: readonly GeminiModel[],
): GeminiModel[] {
  const known = new Map(fallback.map((model) => [model.id, model]));
  const models: GeminiModel[] = [];
  for (const [id, info] of Object.entries(inventory.models ?? {}) as [string, AvailableModelInfo][]) {
    if (info.isInternal === true) continue;
    // Internal routing ids, aliases and capability variants are not selectable
    // chat models. Keeping them would only confuse the model picker.
    if (id.startsWith("chat_") || id.startsWith("tab_")) continue;
    if (id.startsWith("gemini-2.5-")) continue;
    if (/-disabled$|-image$|-preview$/.test(id)) continue;
    const base = known.get(id) ?? fallbackModel(id);
    models.push({
      ...base,
      name: info.displayName ?? base.name,
      context: info.maxTokens && info.maxTokens > 0 ? info.maxTokens : base.context,
      output: info.maxOutputTokens && info.maxOutputTokens > 0 ? info.maxOutputTokens : base.output,
      multimodal: info.supportsImages ?? base.multimodal,
      thinking: info.supportsThinking ?? base.thinking,
      tools: true,
    });
  }
  return models.length > 0 ? models : [...fallback];
}

function toProviderModel(providerID: ReturnType<typeof Provider.ID.make>, model: GeminiModel) {
  return {
    ...Model.Info.default(providerID, Model.ID.make(model.id)),
    name: model.name,
    family: model.family,
    time: { released: Date.parse(model.released) || 0 },
    capabilities: {
      tools: model.tools,
      input: model.multimodal ? ["text", "image", "pdf"] : ["text"],
      output: ["text"],
      temperature: true,
    },
    limit: { context: model.context, output: model.output },
    // Subscription-backed: no per-token price.
    cost: [],
    status: "active" as const,
    enabled: true,
  };
}

export default Plugin.define({
  id: "gemini-sub",
  async setup(ctx) {
    const options = parseOptions(ctx.options);
    const log = (message: string) => console.error(`[gemini-sub] ${message}`);
    const profiles = createProfiles({
      endpoint: options.endpoint,
      antigravityVersion: options.antigravityVersion,
      antigravityUseLegacyHeaders: options.antigravityUseLegacyHeaders,
      clients: options.oauth,
    }).filter((profile) => options.profiles.includes(profile.id));

    const runtimes: Runtime[] = [];

    for (const profile of profiles) {
      const credentials = new CredentialManager({
        path: join(options.dataDir ?? dataDirectory(), profile.credentialsFile),
      });
      try {
        await credentials.bootstrap({
          importGeminiCLI: profile.id === "gemini-cli" && options.importGeminiCLI,
        });
      } catch (cause) {
        log(`${profile.id}: could not load credentials: ${errorMessage(cause)}`);
      }

      const client = new CodeAssistClient({
        credentials,
        profile,
        projectId: options.projectId,
      });

      let catalog: GeminiModel[];
      try {
        catalog = mergeModels(options.models, profile.models);
      } catch (cause) {
        log(`${profile.id}: invalid model overrides, using defaults: ${errorMessage(cause)}`);
        catalog = [...profile.models];
      }
      const catalogRef = { models: catalog };

      let proxy: ProxyHandle | undefined;
      try {
        proxy = await startProxy({
          client,
          credentials,
          options,
          models: () => catalogRef.models,
          log,
        });
      } catch (cause) {
        log(`${profile.id}: could not start the local proxy: ${errorMessage(cause)}`);
        continue;
      }

      const runtime: Runtime = {
        profile,
        credentials,
        client,
        proxy,
        catalog: catalogRef,
        unavailable: [],
        limits: [],
        quotaFetchedAt: 0,
        quotaInFlight: false,
        loginInFlight: false,
      };
      runtimes.push(runtime);
    }

    if (runtimes.length === 0) {
      log("no profile could be initialised");
      return;
    }

    // ---------------------------------------------------------------- providers
    const registerProvider = async (runtime: Runtime): Promise<void> => {
      const providerID = Provider.ID.make(runtime.profile.providerID);
      await ctx.provider.transform((editor) => {
        editor.add({
          info: {
            ...Provider.Info.empty(providerID),
            name: runtime.profile.name,
            activation: "enabled",
            package: "@opencode/ai/providers/google",
            settings: {
              baseURL: runtime.proxy.baseURL,
              // The proxy ignores the key; the Google package requires a value.
              apiKey: "opencode-gemini-sub",
              // Quota waits can last hours; the gate owns the clock.
              headerTimeout: false,
              chunkTimeout: false,
              timeout: false,
            },
          } as never,
          models: runtime.catalog.models.map((model) => toProviderModel(providerID, model)) as never,
        });
      });
    };

    for (const runtime of runtimes) await registerProvider(runtime);

    // ----------------------------------------------------------- model refresh
    const refreshLimits = async (runtime: Runtime, force = false): Promise<void> => {
      if (!runtime.credentials.signedIn) return;
      if (runtime.quotaInFlight) return;
      if (!force && Date.now() - runtime.quotaFetchedAt < 60_000) return;
      runtime.quotaInFlight = true;
      try {
        runtime.limits = await runtime.client.quotaLimits();
        runtime.quotaFetchedAt = Date.now();
      } catch (cause) {
        log(`${runtime.profile.id}: quota lookup failed: ${errorMessage(cause)}`);
      } finally {
        runtime.quotaInFlight = false;
      }
    };

    const refreshCatalog = async (runtime: Runtime): Promise<void> => {
      if (!runtime.profile.discovery || !runtime.credentials.signedIn) return;
      try {
        const inventory = await runtime.client.listAvailableModels();
        const models = modelsFromInventory(inventory, runtime.profile.models);
        runtime.unavailable = Object.entries(inventory.models ?? {})
          .filter(([, info]) => info.disabled === true)
          .map(([id, info]) => ({
            name: info.displayName ?? id,
            reason: info.tagDescription ?? "disabled by Google for this account",
          }));
        if (models.length === 0) return;
        runtime.catalog.models = mergeModels(options.models, models);
        // Registering again is what makes the new list visible immediately;
        // `reload()` alone did not survive the post-login timing.
        await registerProvider(runtime);
        void refreshLimits(runtime, true);
        log(`${runtime.profile.id}: catalogue refreshed (${models.length} models)`);
      } catch (cause) {
        log(`${runtime.profile.id}: model discovery failed: ${errorMessage(cause)}`);
      }
    };

    // Non-blocking: the provider is usable immediately with the fallback list.
    for (const runtime of runtimes) {
      if (!runtime.credentials.signedIn) continue;
      if (runtime.profile.discovery) void refreshCatalog(runtime);
      else void refreshLimits(runtime, true);
    }

    // ------------------------------------------------------------------- rpc
    const buildStatus = (): StatusPayload => ({
      generatedAt: Date.now(),
      profiles: runtimes.map((runtime) => {
        const state = runtime.proxy.state();
        const project = runtime.credentials.project;
        return {
          id: runtime.profile.id,
          name: runtime.profile.name,
          providerID: runtime.profile.providerID,
          signedIn: runtime.credentials.signedIn,
          account: runtime.credentials.credentials?.email ?? "",
          project: project?.projectId ?? "",
          tier: project?.tierName ?? project?.tierId ?? "",
          autoContinue: options.autoContinue,
          blockedUntil: state.quota.blockedUntil,
          waiting: state.quota.waiting,
          requests: state.requests,
          completed: state.completed,
          failures: state.failures,
          quotaWaits: state.quotaWaits,
          lastError: state.lastError ?? "",
          limits: runtime.limits.map((limit) => ({ ...limit })),
          unavailable: runtime.unavailable.map((entry) => ({ ...entry })),
        } satisfies ProfileStatus;
      }),
    });

    await ctx.rpc.register(GeminiSubRpc, {
      status: async () => {
        for (const runtime of runtimes) void refreshLimits(runtime);
        return buildStatus();
      },
    });

    // ---------------------------------------------------------------- commands
    const notify = async (sessionID: string, text: string): Promise<void> => {
      try {
        await ctx.session.synthetic({ sessionID, text });
      } catch (cause) {
        log(`could not post message: ${errorMessage(cause)}`);
      }
    };

    const statusReport = async (refreshQuota: boolean): Promise<string> => {
      const lines: string[] = ["# Gemini subscriptions", ""];
      for (const runtime of runtimes) {
        const { profile, credentials, proxy } = runtime;
        lines.push(`## ${profile.name}`, "");
        lines.push(`- Provider: \`${profile.providerID}\``);
        lines.push(`- Signed in: ${credentials.signedIn ? "yes" : "no"}`);
        if (!credentials.signedIn) {
          lines.push(`- Sign in with \`/${commandPrefix(profile)}-login\``, "");
          continue;
        }
        if (credentials.credentials?.email) lines.push(`- Account: ${credentials.credentials.email}`);
        lines.push(`- Credentials: \`${credentials.path}\``);
        const project = credentials.project;
        if (project) {
          lines.push(`- Project: \`${project.projectId}\``);
          lines.push(`- Tier: ${project.tierName ?? project.tierId ?? "unknown"}${project.paid ? " (paid)" : ""}`);
        }
        const state = proxy.state();
        lines.push(`- Models: ${state.models}`);
        lines.push(
          `- Requests: ${state.requests} (ok ${state.completed}, failed ${state.failures}, quota waits ${state.quotaWaits})`,
        );
        if (state.quota.blockedUntil > Date.now()) {
          lines.push(
            `- Quota gate: closed until ${new Date(state.quota.blockedUntil).toISOString()} (${state.quota.waiting} waiting)`,
          );
        } else {
          lines.push("- Quota gate: open");
        }
        lines.push(`- Auto-continue: ${options.autoContinue ? "on" : "off"}`);
        if (state.lastError) lines.push(`- Last error: ${state.lastError}`);
        if (runtime.unavailable.length > 0) {
          lines.push("", "### Unavailable for this account", "");
          for (const entry of runtime.unavailable) lines.push(`- ${entry.name}: ${entry.reason}`);
        }
        if (refreshQuota) await refreshLimits(runtime, true);
        if (runtime.limits.length > 0) {
          lines.push("", "### Limits", "");
          for (const limit of runtime.limits) {
            const fraction = limit.fraction < 0 ? "n/a" : `${Math.round(limit.fraction * 100)}%`;
            const window = limit.window === "weekly" ? "weekly" : limit.window;
            lines.push(
              `- ${limit.group} · ${window}: ${fraction}` +
                (limit.resetTime ? `, reset ${new Date(limit.resetTime).toISOString()}` : ""),
            );
          }
        }
        lines.push("");
      }
      return lines.join("\n");
    };

    const startLogin = (runtime: Runtime, sessionID: string): void => {
      const { profile } = runtime;
      if (runtime.loginInFlight) {
        void notify(sessionID, `A ${profile.name} sign-in is already in progress.`);
        return;
      }
      if (!profile.oauth.clientId || !profile.oauth.clientSecret) {
        const env = OAUTH_CLIENT_ENV[profile.id];
        void notify(
          sessionID,
          `OAuth client identity for ${profile.name} is missing.\n\n` +
            `Set \`${env.id}\` and \`${env.secret}\`, or configure \`options.oauth.${profile.id}\`. ` +
            "This repository ships no Google credentials; see the README section \"OAuth client identity\".",
        );
        return;
      }
      runtime.loginInFlight = true;
      void notify(sessionID, `Starting ${profile.name} sign-in. Opening the authorization page...`);
      void (async () => {
        try {
          const next = await login({
            clientId: profile.oauth.clientId,
            clientSecret: profile.oauth.clientSecret,
            scopes: profile.oauth.scopes,
            callbackPath: profile.oauth.callbackPath,
            onAuthUrl: (url) => {
              void notify(
                sessionID,
                "Open this URL to authorize OpenCode:\n\n" +
                  `${url}\n\n` +
                  "The login completes automatically once Google redirects back to this machine.",
              );
            },
          });
          await runtime.credentials.setCredentials(next);
          const project = await runtime.client.ensureProject({ refresh: true });
          await refreshCatalog(runtime);
          await notify(
            sessionID,
            `Signed in${next.email ? ` as ${next.email}` : ""}.\n` +
              `Project: \`${project.projectId}\` (${project.tierName ?? project.tierId ?? "unknown tier"}).\n\n` +
              `Pick a model with \`/models\`, e.g. \`${profile.providerID}/${
                runtime.catalog.models[0]?.id ?? "gemini-3-flash"
              }\`.`,
          );
        } catch (cause) {
          await notify(sessionID, `Sign-in failed: ${errorMessage(cause)}`);
        } finally {
          runtime.loginInFlight = false;
        }
      })();
    };

    const stopLogin = async (runtime: Runtime, sessionID: string): Promise<void> => {
      await runtime.credentials.signOut();
      runtime.proxy.gate.reset();
      await notify(sessionID, `${runtime.profile.name} credentials removed.`);
    };

    await ctx.command.transform((editor) => {
      for (const runtime of runtimes) {
        const prefix = commandPrefix(runtime.profile);
        editor.add({
          name: `${prefix}-login`,
          description: `Sign in with a Google account for ${runtime.profile.name} (OAuth, no API key)`,
          execute: async ({ sessionID }: CommandContext) => startLogin(runtime, sessionID),
        });
        editor.add({
          name: `${prefix}-logout`,
          description: `Remove the stored ${runtime.profile.name} credentials`,
          execute: async ({ sessionID }: CommandContext) => stopLogin(runtime, sessionID),
        });
      }

      editor.add({
        name: "gemini-status",
        description: "Show accounts, projects, quota gates and remaining quota for every profile",
        execute: async ({ sessionID }: CommandContext) => {
          await notify(sessionID, await statusReport(true));
        },
      });

      editor.add({
        name: "gemini-autocontinue",
        description: "Enable or disable waiting for a quota reset: /gemini-autocontinue on|off",
        execute: async ({ sessionID, prompt }: CommandContext) => {
          const argument = (prompt?.text ?? "").trim().toLowerCase();
          if (argument === "on" || argument === "off") {
            options.autoContinue = argument === "on";
            await notify(
              sessionID,
              argument === "on"
                ? "Auto-continue enabled: requests now wait for the quota reset and resume automatically."
                : "Auto-continue disabled: a quota error is returned immediately instead of waiting.",
            );
            return;
          }
          await notify(
            sessionID,
            `Auto-continue is currently ${options.autoContinue ? "on" : "off"}. ` +
              "Use `/gemini-autocontinue on` or `/gemini-autocontinue off`.",
          );
        },
      });

      editor.add({
        name: "gemini-models",
        description: "List the models exposed by every enabled profile",
        execute: async ({ sessionID }: CommandContext) => {
          const lines = ["# Models", ""];
          for (const runtime of runtimes) {
            lines.push(`## ${runtime.profile.name}`, "");
            for (const model of runtime.catalog.models) {
              lines.push(
                `- \`${runtime.profile.providerID}/${model.id}\` - ${model.name}` +
                  `${model.tools ? "" : " (no tool calling)"}, ${Math.round(model.context / 1024)}k context`,
              );
            }
            lines.push("");
          }
          await notify(sessionID, lines.join("\n"));
        },
      });
    });

    // ------------------------------------------------------------------- tool
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "gemini_quota",
        description:
          "Report subscription sign-in state, projects, quota gates, request counters and optionally the live per-model quota buckets with reset times.",
        input: {
          type: "object",
          properties: {
            refresh: {
              type: "boolean",
              description: "Ask Google for the current quota buckets (one extra API call per profile).",
            },
          },
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input: unknown) => {
          const refresh = Boolean((input as { refresh?: boolean } | undefined)?.refresh);
          return { content: await statusReport(refresh) };
        },
      });
    });

    if (options.debug) {
      try {
        const registered = await ctx.tool.list();
        log(`registered tools: ${registered.map((tool) => tool.id).join(", ") || "none"}`);
        const commands = await ctx.command.list();
        const commandList = Array.isArray(commands)
          ? commands
          : ((commands as { data?: unknown[] }).data ?? []);
        log(`commands: ${commandList.map((entry) => (entry as { name?: string }).name).join(", ")}`);
      } catch (cause) {
        log(`introspection failed: ${errorMessage(cause)}`);
      }
    }

    log(
      `ready: ${runtimes
        .map((runtime) => `${runtime.profile.id}(${runtime.catalog.models.length} models)`)
        .join(", ")}`,
    );

    return async () => {
      await Promise.all(runtimes.map((runtime) => runtime.proxy.close().catch(() => {})));
    };
  },
});

function commandPrefix(profile: Profile): string {
  return profile.id === "antigravity" ? "antigravity" : "gemini";
}
