/**
 * Clean-room client for the Cloud Code Assist backend.
 *
 * Two wire dialects share this transport:
 *
 *   gemini-cli   { model, project, user_prompt_id, request: { ..., session_id } }
 *   antigravity  { project, model, request: { ... }, userAgent, requestId }
 *
 * Everything else (host, OAuth client, headers, model inventory) comes from a
 * `Profile`. Facts were reconstructed from observed client traffic; no Google
 * source code is used.
 */

import type { CredentialManager, ProjectInfo } from "./credentials.ts";
import type { Profile } from "./profiles.ts";
import { osType } from "./profiles.ts";

export type CodeAssistEnvelope = Record<string, unknown>;

/** Some backend responses use a plain string, others an object. */
export type ProjectRef = string | { id?: string; name?: string } | undefined;

export interface LoadCodeAssistResponse {
  currentTier?: { id?: string; name?: string; hasOnboardedPreviously?: boolean };
  paidTier?: { id?: string; name?: string };
  allowedTiers?: { id?: string; name?: string; isDefault?: boolean; userDefinedCloudaicompanionProject?: boolean }[];
  cloudaicompanionProject?: ProjectRef;
  ineligibleTiers?: {
    reasonMessage?: string;
    reasonCode?: string;
    validationUrl?: string;
    tierId?: string;
    tierName?: string;
  }[];
}

export interface LongRunningOperation {
  name?: string;
  done?: boolean;
  response?: { cloudaicompanionProject?: ProjectRef };
}

export interface QuotaBucket {
  remainingAmount?: string;
  remainingFraction?: number;
  resetTime?: string;
  tokenType?: string;
  modelId?: string;
}

export interface UserQuota {
  buckets?: QuotaBucket[];
}

export interface QuotaSummaryBucket {
  bucketId?: string;
  displayName?: string;
  description?: string;
  window?: string;
  resetTime?: string;
  remainingFraction?: number;
  remainingAmount?: string;
}

export interface QuotaSummaryGroup {
  displayName?: string;
  description?: string;
  buckets?: QuotaSummaryBucket[];
}

export interface QuotaSummaryResponse {
  groups?: QuotaSummaryGroup[];
  buckets?: QuotaSummaryBucket[];
}

/** One account-level limit window (5h or weekly) for a model pool. */
export interface QuotaLimit {
  /** Pool key: `gemini`, `3p` (Claude/GPT), or a custom slug. */
  key: string;
  group: string;
  /** `5h`, `weekly`, or a raw backend value. */
  window: string;
  /** 0..1, or -1 when unknown. */
  fraction: number;
  /** ISO timestamp, empty when unknown. */
  resetTime: string;
}

export interface AvailableModelInfo {
  displayName?: string;
  maxTokens?: number;
  maxOutputTokens?: number;
  supportsImages?: boolean;
  supportsThinking?: boolean;
  supportsVideo?: boolean;
  isInternal?: boolean;
  disabled?: boolean;
  recommended?: boolean;
  tagTitle?: string;
  tagDescription?: string;
  apiProvider?: string;
  modelProvider?: string;
  model?: string;
  quotaInfo?: { remainingFraction?: number; resetTime?: string };
}

export interface AvailableModelsResponse {
  models?: Record<string, AvailableModelInfo>;
  defaultAgentModelId?: string;
}

export class CodeAssistError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `Code Assist request failed with HTTP ${status}: ${body.slice(0, 400)}`);
    this.name = "CodeAssistError";
    this.status = status;
    this.body = body;
  }
}

export interface ClientOptions {
  credentials: CredentialManager;
  profile: Profile;
  /** Delay between onboarding operation polls. Defaults to 2 s. */
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  /** Override for tests. */
  projectId?: string;
}

export class CodeAssistClient {
  readonly profile: Profile;
  readonly #credentials: CredentialManager;
  readonly #fetch: typeof fetch;
  readonly #projectOverride: string | undefined;
  readonly #pollIntervalMs: number;
  #project: ProjectInfo | undefined;
  #sessionId = crypto.randomUUID();

  constructor(options: ClientOptions) {
    this.profile = options.profile;
    this.#credentials = options.credentials;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#projectOverride = options.projectId;
    this.#pollIntervalMs = options.pollIntervalMs ?? 2_000;
  }

  get endpoint(): string {
    return `${this.profile.endpoint.replace(/\/+$/, "")}/v1internal`;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get projectId(): string | undefined {
    return this.#projectOverride ?? this.#project?.projectId ?? this.#credentials.project?.projectId;
  }

  get project(): ProjectInfo | undefined {
    return this.#project ?? this.#credentials.project;
  }

  #userAgent(model?: string, kind: "content" | "control" | "onboard" = "content"): string {
    let ua = this.profile.userAgent
      .replaceAll("{model}", model ? stripModelsPrefix(model) : "unknown")
      .replaceAll("{platform}", process.platform)
      .replaceAll("{arch}", process.arch)
      .replaceAll("{os_type}", osType());
    if (this.profile.envelope === "antigravity" && kind === "onboard") {
      ua = `${ua} google-api-nodejs-client/10.3.0`;
    }
    return ua;
  }

  #headers(
    model?: string,
    kind: "content" | "control" | "onboard" = "content",
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": this.#userAgent(model, kind),
      ...this.profile.headers,
    };
    if (this.profile.envelope === "antigravity" && kind === "onboard") {
      headers["x-goog-api-client"] = "gl-node/22.21.1";
    }
    return headers;
  }

  async #fetchAuthorized(url: string, init: RequestInit, retry = true): Promise<Response> {
    const token = await this.#credentials.accessToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    const response = await this.#fetch(url, { ...init, headers });
    if (response.status === 401 && retry) {
      await response.body?.cancel();
      await this.#credentials.invalidate();
      await this.#credentials.refresh();
      return this.#fetchAuthorized(url, init, false);
    }
    return response;
  }

  async #post<T>(
    method: string,
    payload: unknown,
    options: { signal?: AbortSignal; kind?: "content" | "control" | "onboard"; model?: string } = {},
  ): Promise<T> {
    const response = await this.#fetchAuthorized(`${this.endpoint}:${method}`, {
      method: "POST",
      headers: this.#headers(options.model, options.kind ?? "control"),
      body: JSON.stringify(payload),
      signal: options.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new CodeAssistError(response.status, text);
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  #metadata(project?: string): Record<string, unknown> {
    if (this.profile.envelope === "cli") {
      return { ...this.profile.metadata, duetProject: project };
    }
    return { ...this.profile.metadata };
  }

  async loadCodeAssist(cloudaicompanionProject?: string): Promise<LoadCodeAssistResponse> {
    const project =
      cloudaicompanionProject ??
      process.env["GOOGLE_CLOUD_PROJECT"] ??
      process.env["GOOGLE_CLOUD_PROJECT_ID"] ??
      undefined;
    return this.#post<LoadCodeAssistResponse>(
      "loadCodeAssist",
      {
        cloudaicompanionProject: project,
        metadata: this.#metadata(project),
      },
      { kind: "control" },
    );
  }

  async onboardUser(tierId: string, cloudaicompanionProject?: string): Promise<LongRunningOperation> {
    return this.#post<LongRunningOperation>(
      "onboardUser",
      {
        tierId,
        cloudaicompanionProject,
        metadata: this.#metadata(cloudaicompanionProject),
      },
      { kind: "onboard" },
    );
  }

  async getOperation(name: string): Promise<LongRunningOperation> {
    const response = await this.#fetchAuthorized(`${this.endpoint}/${name}`, {
      method: "GET",
      headers: this.#headers(undefined, "control"),
    });
    const text = await response.text();
    if (!response.ok) throw new CodeAssistError(response.status, text);
    return JSON.parse(text) as LongRunningOperation;
  }

  /**
   * Resolve the Cloud project that owns this account, onboarding it when
   * necessary. Mirrors the tier negotiation of the original clients.
   */
  async ensureProject(options: { refresh?: boolean } = {}): Promise<ProjectInfo> {
    const cached = this.#project ?? this.#credentials.project;
    if (!options.refresh && cached && Date.now() - cached.fetchedAt < 24 * 3_600_000) {
      this.#project = cached;
      return cached;
    }

    const envProject =
      this.#projectOverride ?? process.env["GOOGLE_CLOUD_PROJECT"] ?? process.env["GOOGLE_CLOUD_PROJECT_ID"];
    if (envProject && /^\d+$/.test(envProject)) {
      throw new Error(
        `GOOGLE_CLOUD_PROJECT must be a project id such as "my-project-123", not a numeric project number (${envProject}).`,
      );
    }

    const loaded = await this.loadCodeAssist(envProject);
    let projectId = projectID(loaded.cloudaicompanionProject) ?? envProject;
    let onboarding: LongRunningOperation | undefined;
    let tier = loaded.paidTier?.id ? loaded.paidTier : loaded.currentTier;

    if (!tier?.id) {
      const candidate =
        loaded.allowedTiers?.find((entry) => entry.isDefault) ??
        loaded.allowedTiers?.find((entry) => entry.id === "free-tier") ??
        (loaded.allowedTiers?.length ? loaded.allowedTiers[0] : undefined);
      if (!candidate?.id) throw new Error(describeEligibility(loaded));

      const needsProject = candidate.userDefinedCloudaicompanionProject === true;
      if (needsProject && !projectId) throw new Error(describeEligibility(loaded, { needsProject: true }));

      onboarding = await this.onboardUser(candidate.id, needsProject ? projectId : undefined);
      for (let attempt = 0; !onboarding.done && onboarding.name && attempt < 60; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, this.#pollIntervalMs));
        onboarding = await this.getOperation(onboarding.name);
      }
      tier = candidate;
      projectId = projectID(onboarding.response?.cloudaicompanionProject) ?? projectId;

      if (!projectId) {
        const retry = await this.loadCodeAssist(envProject);
        projectId = projectID(retry.cloudaicompanionProject) ?? projectId;
      }
      if (!projectId) throw new Error(describeMissingProject({ loaded, onboarding, tier }));
    }

    if (!projectId) throw new Error(describeMissingProject({ loaded, onboarding, tier }));

    const info: ProjectInfo = {
      projectId,
      tierId: tier?.id,
      tierName: tier?.name,
      paid: Boolean(loaded.paidTier?.id) || tier?.id === "standard-tier",
      fetchedAt: Date.now(),
    };
    this.#project = info;
    await this.#credentials.setProject(info);
    return info;
  }

  async requireProject(): Promise<string> {
    if (this.projectId) return this.projectId;
    return (await this.ensureProject()).projectId;
  }

  /** Build the request body for this profile's dialect. */
  envelope(input: {
    model: string;
    body: Record<string, unknown>;
    project?: string;
    promptId?: string;
  }): CodeAssistEnvelope {
    const model = stripModelsPrefix(input.model);
    if (this.profile.envelope === "antigravity") {
      return {
        project: input.project,
        model,
        request: { ...input.body },
        userAgent: "antigravity",
        requestId: input.promptId ?? crypto.randomUUID(),
      };
    }
    const request: Record<string, unknown> = { ...input.body };
    request.session_id = this.#sessionId;
    return {
      model,
      project: input.project,
      user_prompt_id: input.promptId ?? crypto.randomUUID(),
      request,
    };
  }

  async stream(envelope: CodeAssistEnvelope, options: { signal?: AbortSignal } = {}): Promise<Response> {
    const project = (envelope["project"] as string | undefined) ?? (await this.requireProject());
    const model = String(envelope["model"] ?? "");
    return this.#fetchAuthorized(`${this.endpoint}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { ...this.#headers(model, "content"), accept: "text/event-stream" },
      body: JSON.stringify({ ...envelope, project }),
      signal: options.signal,
    });
  }

  async generate(envelope: CodeAssistEnvelope, options: { signal?: AbortSignal } = {}): Promise<Response> {
    const project = (envelope["project"] as string | undefined) ?? (await this.requireProject());
    const model = String(envelope["model"] ?? "");
    return this.#fetchAuthorized(`${this.endpoint}:generateContent`, {
      method: "POST",
      headers: this.#headers(model, "content"),
      body: JSON.stringify({ ...envelope, project }),
      signal: options.signal,
    });
  }

  async countTokens(input: { model: string; contents: unknown; signal?: AbortSignal }): Promise<{ totalTokens?: number }> {
    return this.#post<{ totalTokens?: number }>(
      "countTokens",
      {
        request: {
          model: input.model.startsWith("models/") ? input.model : `models/${input.model}`,
          contents: input.contents,
        },
      },
      { signal: input.signal, kind: "content", model: input.model },
    );
  }

  /**
   * Account-level quota summary: grouped pools with a 5-hour and a weekly
   * window. This is what the official client's usage page shows.
   */
  async quotaSummary(project?: string): Promise<QuotaSummaryResponse> {
    const resolved = project ?? (await this.requireProject());
    return this.#post<QuotaSummaryResponse>(
      "retrieveUserQuotaSummary",
      { project: resolved },
      { kind: "control" },
    );
  }

  /** Normalized 5h/weekly limits, with a per-model fallback. */
  async quotaLimits(project?: string): Promise<QuotaLimit[]> {
    if (this.profile.discovery) {
      try {
        const summary = await this.quotaSummary(project);
        const groups =
          summary.groups && summary.groups.length > 0
            ? summary.groups
            : [{ buckets: summary.buckets ?? [] } as QuotaSummaryGroup];
        const limits: QuotaLimit[] = [];
        for (const group of groups) {
          for (const bucket of group.buckets ?? []) {
            limits.push({
              key: groupKey(group, bucket),
              group: group.displayName ?? groupKey(group, bucket),
              window: normalizeWindow(bucket.window ?? bucket.bucketId),
              fraction: bucket.remainingFraction ?? -1,
              resetTime: bucket.resetTime ?? "",
            });
          }
        }
        if (limits.length > 0) return limits;
      } catch {
        // Older/business accounts may not expose the summary; fall through.
      }
    }
    return this.#limitsFromModels(project);
  }

  async #limitsFromModels(project?: string): Promise<QuotaLimit[]> {
    const quota = await this.retrieveUserQuota(project);
    const best = new Map<string, QuotaLimit>();
    for (const bucket of quota.buckets ?? []) {
      if (!bucket.modelId) continue;
      const key = /claude|gpt/i.test(bucket.modelId) ? "3p" : "gemini";
      const fraction = bucket.remainingFraction ?? -1;
      const existing = best.get(key);
      if (!existing || fraction < existing.fraction) {
        best.set(key, {
          key,
          group: key === "3p" ? "Claude and GPT models" : "Gemini Models",
          window: "5h",
          fraction,
          resetTime: bucket.resetTime ?? "",
        });
      }
    }
    return [...best.values()];
  }

  /** Account-specific model inventory, including per-model quota. */
  async listAvailableModels(project?: string): Promise<AvailableModelsResponse> {
    const resolved = project ?? (await this.requireProject());
    return this.#post<AvailableModelsResponse>(
      "fetchAvailableModels",
      { project: resolved },
      { kind: "control" },
    );
  }

  /** Per-model quota buckets. Uses discovery when the profile supports it. */
  async retrieveUserQuota(project?: string): Promise<UserQuota> {
    const resolved = project ?? (await this.requireProject());
    if (!this.profile.discovery) {
      return this.#post<UserQuota>("retrieveUserQuota", { project: resolved }, { kind: "control" });
    }
    const inventory = await this.listAvailableModels(resolved);
    const buckets: QuotaBucket[] = Object.entries(inventory.models ?? {}).map(([modelId, info]) => ({
      modelId,
      remainingFraction: info.quotaInfo?.remainingFraction,
      resetTime: info.quotaInfo?.resetTime,
    }));
    return { buckets };
  }

  async fetchAdminControls(project?: string): Promise<Record<string, unknown>> {
    const resolved = project ?? (await this.requireProject());
    return this.#post<Record<string, unknown>>(
      "fetchAdminControls",
      { project: resolved, metadata: this.profile.metadata },
      { kind: "control" },
    );
  }
}

/** Accept both shapes the backend uses for a project reference. */
export function projectID(value: ProjectRef): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (value && typeof value === "object" && typeof value.id === "string" && value.id.length > 0) return value.id;
  return undefined;
}

/** Remove the `models/` prefix the Gemini REST API uses in paths. */
export function stripModelsPrefix(id: string): string {
  return id.startsWith("models/") ? id.slice("models/".length) : id;
}

function truncateJson(value: unknown, limit = 1200): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function describeEligibility(
  loaded: LoadCodeAssistResponse,
  options: { needsProject?: boolean } = {},
): string {
  const unsupported = loaded.ineligibleTiers?.find((entry) => entry.reasonCode === "UNSUPPORTED_CLIENT");
  const reasons = loaded.ineligibleTiers
    ?.map((entry) => entry.reasonMessage ?? entry.reasonCode)
    .filter(Boolean);
  const lines: string[] = [];
  if (unsupported) {
    lines.push(
      `Google no longer allows this OAuth client for the Code Assist individual tier (${unsupported.tierId ?? "free-tier"}: UNSUPPORTED_CLIENT).`,
    );
    if (unsupported.reasonMessage) lines.push(unsupported.reasonMessage);
  } else {
    lines.push("This account is not eligible for Gemini Code Assist.");
    if (reasons?.length) lines.push(`Reasons: ${reasons.join("; ")}`);
  }
  if (options.needsProject) {
    lines.push(
      "The remaining tier requires a Cloud project. Set GOOGLE_CLOUD_PROJECT to a project id with the " +
        "Gemini for Google Cloud API (cloudaicompanion.googleapis.com) enabled and a Code Assist subscription, " +
        "then run the login command again.",
    );
  }
  lines.push(`Tiers: ${truncateJson(loaded.allowedTiers ?? [])}`);
  return lines.join("\n");
}

function describeMissingProject(input: {
  loaded: LoadCodeAssistResponse;
  onboarding: LongRunningOperation | undefined;
  tier: { id?: string; name?: string } | undefined;
}): string {
  const reasons = input.loaded.ineligibleTiers
    ?.map((entry) => entry.reasonMessage ?? entry.reasonCode)
    .filter(Boolean);
  const diagnostics = {
    tier: input.tier,
    currentTier: input.loaded.currentTier,
    paidTier: input.loaded.paidTier,
    allowedTiers: input.loaded.allowedTiers,
    ineligibleTiers: input.loaded.ineligibleTiers,
    onboarding: input.onboarding
      ? { done: input.onboarding.done, name: input.onboarding.name, response: input.onboarding.response }
      : undefined,
  };
  return [
    "Google finished onboarding but returned no Cloud project.",
    `Tier: ${input.tier?.name ?? input.tier?.id ?? "unknown"}`,
    ...(reasons?.length ? [`Reasons: ${reasons.join("; ")}`] : []),
    "Set GOOGLE_CLOUD_PROJECT to a Cloud project id with the Gemini for Google Cloud API " +
      "(cloudaicompanion.googleapis.com) enabled, then run the login command again.",
    `Diagnostics: ${truncateJson(diagnostics)}`,
  ].join("\n");
}

/**
 * Compatibility shim for hot reloads of an older module graph. New code uses
 * `CodeAssistClient.envelope`; this keeps a previously loaded proxy working
 * until the server restarts.
 */
export function buildEnvelope(input: {
  model: string;
  body: Record<string, unknown>;
  project?: string;
  sessionId?: string;
  promptId?: string;
}): CodeAssistEnvelope {
  const request: Record<string, unknown> = { ...input.body };
  if (input.sessionId) request.session_id = input.sessionId;
  return {
    model: stripModelsPrefix(input.model),
    project: input.project,
    user_prompt_id: input.promptId ?? crypto.randomUUID(),
    request,
  };
}


function normalizeWindow(value: string | undefined): string {
  const raw = (value ?? "").trim().toLowerCase();
  if (raw === "weekly" || raw === "week" || raw === "7d" || raw === "168h") return "weekly";
  if (raw === "5h" || raw === "five_hour" || raw === "five-hour" || raw === "300m") return "5h";
  // Bucket ids look like `gemini-weekly` / `3p-5h`.
  const suffix = raw.split("-").at(-1);
  if (suffix && suffix !== raw) return normalizeWindow(suffix);
  return raw || "window";
}

function groupKey(group: QuotaSummaryGroup, bucket: QuotaSummaryBucket): string {
  const label = (group.displayName ?? "").toLowerCase();
  if (label.includes("claude") || label.includes("gpt") || label.includes("3p")) return "3p";
  if (label.includes("gemini")) return "gemini";
  const id = (bucket.bucketId ?? "").toLowerCase();
  if (id.startsWith("3p") || id.includes("claude") || id.includes("gpt")) return "3p";
  if (id.startsWith("gemini")) return "gemini";
  const slug = label.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || "group";
}
