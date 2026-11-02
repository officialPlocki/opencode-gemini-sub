/**
 * TUI part: a compact quota panel in the right sidebar.
 *
 * Visible only while a session is actually running a Gemini/Antigravity model.
 * Shows the two account limits of the active model pool (5-hour window and
 * weekly limit) and whether the proxy is currently parked waiting for a reset.
 */

import { For, Show, createSignal, on, createEffect, onCleanup, onMount } from "solid-js";
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { GeminiSubRpc, type LimitRow, type ProfileStatus, type StatsPayload, type StatusPayload } from "./rpc.ts";

const POLL_MS = 2_500;
const BAR_WIDTH = 6;

function poolFor(modelID: string | undefined): string | undefined {
  if (!modelID) return undefined;
  return /claude|gpt/i.test(modelID) ? "3p" : "gemini";
}

function bar(fraction: number): string {
  if (fraction < 0) return "░".repeat(BAR_WIDTH);
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(fraction * BAR_WIDTH)));
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

function percent(fraction: number): string {
  return fraction < 0 ? "  ?" : `${Math.round(fraction * 100)}%`.padStart(4);
}

function windowLabel(window: string): string {
  if (window === "weekly") return "1w";
  if (window === "5h") return "5h";
  return window.slice(0, 2);
}

function shortDuration(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
  return `${Math.floor(minutes / (24 * 60))}d${Math.floor((minutes % (24 * 60)) / 60)}h`;
}

function clock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${Math.round(value)}`;
}

function rate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "–";
  return value >= 10 ? `${Math.round(value)}` : value.toFixed(1);
}

function QuotaPanel(props: { sessionID: string }) {
  const context = usePlugin();
  const [data, setData] = createSignal<StatusPayload>();
  const [stats, setStats] = createSignal<StatsPayload>();
  const [now, setNow] = createSignal(Date.now());

  onMount(() => {
    let alive = true;
    let busy = false;

    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const rpc = context.client.rpc(GeminiSubRpc);
        const [statusResult, statsResult] = await Promise.allSettled([
          rpc.status({}),
          rpc.stats({ sessionID: props.sessionID }),
        ]);
        if (alive && statusResult.status === "fulfilled") {
          setData(statusResult.value as unknown as StatusPayload);
        }
        if (alive && statsResult.status === "fulfilled") {
          setStats(statsResult.value as unknown as StatsPayload);
        }
      } catch {
        // Server restarting or plugin unloaded: keep the last data.
      } finally {
        busy = false;
        if (alive) setNow(Date.now());
      }
    };

    void tick();
    const timer = setInterval(tick, POLL_MS);
    onCleanup(() => {
      alive = false;
      clearInterval(timer);
    });
  });

  const selected = () => context.ui.model.current();

  createEffect(on(() => props.sessionID, () => {
    setData(undefined);
    setStats(undefined);
  }));

  const activeProfile = (): ProfileStatus | undefined => {
    const model = selected();
    if (!model) return undefined;
    return (data()?.profiles ?? []).find((profile) => profile.providerID === model.providerID);
  };

  // Visible whenever one of our models is selected, idle or running. Switching
  // to a non-Gemini model hides it; `now()` keeps the countdowns fresh.
  const visible = (): ProfileStatus | undefined => {
    now();
    const profile = activeProfile();
    return profile?.signedIn ? profile : undefined;
  };

  /**
   * Gemini CLI quota is request usage, not a balance: the CLI itself renders
   * "x% used" with the reset time. Take the most consumed bucket.
   */
  const cliUsage = (profile: ProfileStatus): { used: number; resetTime: string } | undefined => {
    const rows = profile.limits.filter((limit) => limit.fraction >= 0);
    if (rows.length === 0) return undefined;
    const lowest = rows.reduce((min, row) => (row.fraction < min.fraction ? row : min));
    return { used: 1 - lowest.fraction, resetTime: lowest.resetTime };
  };

  const usageColor = (used: number) => {
    if (used >= 0.8) return context.theme.text.feedback.error.base;
    if (used >= 0.6) return context.theme.text.feedback.warning.base;
    return context.theme.text.muted;
  };

  const rows = (profile: ProfileStatus): LimitRow[] => {
    const key = poolFor(selected()?.modelID);
    const matching = key ? profile.limits.filter((limit) => limit.key === key) : [];
    const list = matching.length > 0 ? matching : profile.limits;
    return [...list]
      .sort((left, right) => (left.window === right.window ? 0 : left.window === "5h" ? -1 : 1))
      .slice(0, 2);
  };

  const running = (): boolean => {
    now();
    return context.data.session.status(props.sessionID) === "running";
  };

  const barColor = (fraction: number) => {
    if (fraction >= 0 && fraction <= 0.1) return context.theme.text.feedback.error.base;
    if (fraction >= 0 && fraction <= 0.3) return context.theme.text.feedback.warning.base;
    return context.theme.text.muted;
  };

  const resetFrom = (resetTime: string): string => {
    if (!resetTime) return "";
    const at = Date.parse(resetTime);
    if (!Number.isFinite(at) || at <= now()) return "";
    return shortDuration(at - now());
  };

  const resetIn = (row: LimitRow): string => resetFrom(row.resetTime);

  return (
    <Show when={visible()}>
      {(profile) => (
        <box flexDirection="column">
          <text fg={context.theme.text.faint}>GEMINI USAGE</text>
          <text fg={context.theme.text.base}>
            {profile().id === "gemini-cli" ? "API-NUTZUNG" : rows(profile())[0]?.group ?? profile().tier ?? "Limits"}
          </text>
          <Show
            when={profile().blockedUntil > now()}
            fallback={<text fg={context.theme.text.muted}>{running() ? "▶ running" : "▶ ready"}</text>}
          >
            <text fg={context.theme.text.feedback.warning.base}>
              {`⏸ waiting ${shortDuration(profile().blockedUntil - now())} · ${clock(profile().blockedUntil)}` +
                (profile().waiting > 1 ? ` · ${profile().waiting} queued` : "")}
            </text>
          </Show>
          <Show
            when={profile().id === "gemini-cli"}
            fallback={
              <For each={rows(profile())}>
                {(row) => (
                  <text fg={barColor(row.fraction)}>
                    {`${windowLabel(row.window).padEnd(2)} ${bar(row.fraction)} ${percent(row.fraction)} frei · ${resetIn(row)}`}
                  </text>
                )}
              </For>
            }
          >
            <Show
              when={cliUsage(profile())}
              fallback={<text fg={context.theme.text.faint}>keine API-Nutzung gemeldet</text>}
            >
              {(usage) => (
                <text fg={usageColor(usage().used)}>
                  {`${bar(usage().used)} ${percent(usage().used)} ${resetFrom(usage().resetTime)}`}
                </text>
              )}
            </Show>
          </Show>
          <Show when={profile().limits.length === 0}>
            <text fg={context.theme.text.faint}>no limit data yet</text>
          </Show>
          <Show when={stats()}>
            {(value) => (
              <Show when={value().outputTokens > 0}>
                <text fg={context.theme.text.faint}>STATS</text>
                <text fg={context.theme.text.muted}>
                  {`${compact(value().turns)} turns · ${compact(value().steps)} steps`}
                </text>
                <text fg={context.theme.text.muted}>
                  {`${rate(value().tokensPerSecond)} tok/s · ${compact(value().outputTokens)} tok`}
                </text>
              </Show>
            )}
          </Show>
          <Show when={!profile().autoContinue}>
            <text fg={context.theme.text.muted}>auto-continue off</text>
          </Show>
        </box>
      )}
    </Show>
  );
}

export default Plugin.define({
  id: "gemini-sub.tui",
  setup(context) {
    return context.ui.slot({
      append: "sidebar.content",
      render: (input) => <QuotaPanel sessionID={input.sessionID} />,
    });
  },
});
