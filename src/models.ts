/**
 * Model catalogue for subscription-backed Gemini access.
 *
 * Code Assist does not expose a discovery endpoint that is usable before a
 * conversation has started, so the catalogue is maintained locally. The ids
 * are the ones the backend accepts as the `model` field of a Code Assist
 * request; users can extend or override the list through plugin options.
 */

export interface GeminiModel {
  /** Model id sent to the backend and used as the OpenCode model id. */
  id: string;
  /** Human readable name shown in `/models`. */
  name: string;
  /** Model family, used for grouping in the model picker. */
  family: string;
  /** Release date, `YYYY-MM-DD`. */
  released: string;
  /** Maximum context window in tokens. */
  context: number;
  /** Maximum output tokens. */
  output: number;
  /** Whether the model supports function calling. */
  tools: boolean;
  /** Whether the model accepts image/pdf input. */
  multimodal: boolean;
  /** Whether the model exposes a thinking budget. */
  thinking: boolean;
  /** Whether the model is offered to free (non-paid) Code Assist tiers. */
  freeTier: boolean;
}

const M = (model: Omit<GeminiModel, "multimodal" | "freeTier"> & Partial<Pick<GeminiModel, "multimodal" | "freeTier">>): GeminiModel => ({
  multimodal: true,
  freeTier: false,
  ...model,
});

export const GEMINI_MODELS: readonly GeminiModel[] = [
  M({
    id: "gemini-3-pro-preview",
    name: "Gemini 3 Pro (preview)",
    family: "gemini-3",
    released: "2026-02-05",
    context: 1_048_576,
    output: 65_536,
    tools: true,
    thinking: true,
  }),
  M({
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro (preview)",
    family: "gemini-3",
    released: "2026-06-10",
    context: 1_048_576,
    output: 65_536,
    tools: true,
    thinking: true,
  }),
  M({
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash (preview)",
    family: "gemini-3",
    released: "2026-02-05",
    context: 1_048_576,
    output: 65_536,
    tools: true,
    thinking: true,
    freeTier: true,
  }),
  M({
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    family: "gemini-3",
    released: "2026-04-22",
    context: 1_048_576,
    output: 65_536,
    tools: true,
    thinking: true,
    freeTier: true,
  }),
  M({
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    family: "gemini-3",
    released: "2026-09-16",
    context: 1_048_576,
    output: 65_536,
    tools: true,
    thinking: true,
  }),
  M({
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite",
    family: "gemini-3",
    released: "2026-05-13",
    context: 1_048_576,
    output: 65_536,
    tools: true,
    thinking: false,
    freeTier: true,
  }),
  M({
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash Lite",
    family: "gemini-3",
    released: "2026-08-19",
    context: 1_048_576,
    output: 65_536,
    tools: true,
    thinking: false,
  }),
  M({
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    family: "gemini-2.5",
    released: "2025-06-17",
    context: 1_048_576,
    output: 65_536,
    tools: true,
    thinking: true,
    freeTier: true,
  }),
  M({
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    family: "gemini-2.5",
    released: "2025-06-17",
    context: 1_048_576,
    output: 65_536,
    tools: true,
    thinking: true,
    freeTier: true,
  }),
  M({
    id: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    family: "gemini-2.5",
    released: "2025-07-22",
    context: 1_048_576,
    output: 65_536,
    tools: true,
    thinking: false,
    freeTier: true,
  }),
  M({
    id: "gemma-4-31b-it",
    name: "Gemma 4 31B",
    family: "gemma",
    released: "2026-03-01",
    context: 131_072,
    output: 8_192,
    tools: false,
    thinking: false,
    freeTier: true,
  }),
  M({
    id: "gemma-4-26b-a4b-it",
    name: "Gemma 4 26B A4B",
    family: "gemma",
    released: "2026-03-01",
    context: 131_072,
    output: 8_192,
    tools: false,
    thinking: false,
    freeTier: true,
  }),
];

/** Look up a model by backend id, tolerating a `models/` prefix. */
export function findModel(id: string): GeminiModel | undefined {
  const normalized = id.startsWith("models/") ? id.slice("models/".length) : id;
  return GEMINI_MODELS.find((model) => model.id === normalized);
}

/** Backend model id without the `models/` prefix used by the Gemini REST API. */
export function normalizeModelID(id: string): string {
  return id.startsWith("models/") ? id.slice("models/".length) : id;
}

/** Merge user overrides on top of the built-in catalogue. */
export function mergeModels(
  overrides: readonly (Partial<GeminiModel> & { id: string })[] | undefined,
  source: readonly GeminiModel[] = GEMINI_MODELS,
): GeminiModel[] {
  const base = new Map(source.map((model) => [model.id, model]));
  for (const override of overrides ?? []) {
    const existing = base.get(override.id);
    if (existing) base.set(override.id, { ...existing, ...override, id: override.id });
    else
      base.set(override.id, {
        ...M({
          id: override.id,
          name: override.id,
          family: "custom",
          released: "1970-01-01",
          context: 1_048_576,
          output: 65_536,
          tools: true,
          thinking: false,
        }),
        ...override,
      });
  }
  return [...base.values()];
}
