<h1 align="center">opencode-gemini-sub</h1>

<p align="center">
  Use a Google Gemini subscription in <b>OpenCode V2</b> — through the Antigravity or Gemini CLI client protocol.<br/>
  Full tool calling, streaming, model discovery, a live quota sidebar and quota-aware auto-continue.
</p>

<p align="center">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg" />
  <img alt="OpenCode" src="https://img.shields.io/badge/OpenCode-V2-111111" />
  <img alt="Platform" src="https://img.shields.io/badge/platform-linux%20%7C%20macOS%20%7C%20Windows-lightgrey" />
  <img alt="Status" src="https://img.shields.io/badge/status-experimental-orange" />
  <img alt="GitHub stars" src="https://img.shields.io/github/stars/officialPlocki/opencode-gemini-sub?style=flat" />
</p>

> [!WARNING]
> **Unofficial and not affiliated with Google.** This plugin emulates Google's own clients
> (Antigravity / Gemini CLI) to use their subscription entitlements from OpenCode. Google's
> terms may treat this as a policy-violating use case and may restrict or terminate accounts.
> Use it only with your own account, at your own risk, and read [`LEGAL.md`](LEGAL.md) first.
>
> Antigravity access depends on your plan and account. The Gemini CLI profile is rejected for
> the individual tier (`UNSUPPORTED_CLIENT`); it remains useful for paid Code Assist
> Standard/Enterprise subscriptions only. If you need the lowest-risk setup, use the official
> Gemini API key or Vertex AI provider instead.
>
> **No warranty and no liability.** No guarantee is given for the information in
> [`LEGAL.md`](LEGAL.md). To the maximum extent permitted by law, the authors accept no
> liability for damages, data loss, account restrictions, suspensions, terminations, charges
> or any other loss arising from the use of this software. Use at your own risk.

## Why

OpenCode ships first-class support for ChatGPT and Copilot subscriptions, but not for Google's
consumer plans. This plugin closes that gap without an API key:

* the **Antigravity** profile speaks the current consumer protocol and gives you Gemini,
  Claude and GPT-OSS models from a Google AI Pro/Ultra plan;
* the **Gemini CLI** profile speaks the Code Assist protocol for paid Standard/Enterprise
  organizations;
* both keep OpenCode's native Gemini request format, so function calling, thought signatures
  and streaming work unchanged.

```
OpenCode ──Gemini REST──▶ loopback proxy ──Cloud Code Assist──▶ Google
                              │
                              ├─ OAuth tokens (per profile)
                              ├─ quota gate + auto-continue
                              └─ model discovery
```

## Features

| Feature | What it does |
| --- | --- |
| **Zero-loss tool calling** | OpenCode's Gemini payload passes through untouched: `tools`, `parametersJsonSchema`, `functionCall`/`functionResponse`, `thoughtSignature` |
| **Streaming** | Native SSE, unwrapped from the Code Assist envelope by an incremental parser |
| **Model discovery** | `fetchAvailableModels` for Antigravity; ids, names, context/output limits and image support come from your account |
| **Two account limits** | 5-hour window and weekly limit per pool (`retrieveUserQuotaSummary`), not per-model noise |
| **Auto-continue** | On quota errors the request stays open, the gate wakes at the reset timestamp, then the same request resumes |
| **Sidebar** | Live usage panel: `5h`/`1w` for Antigravity, API usage for Gemini CLI |
| **Quota tool** | Agents can inspect account, project, tier, limits and gate state with `gemini_quota` |
| **Local-only credentials** | Tokens live in a `0600` JSON file; no telemetry, no analytics |

## Prerequisites

- OpenCode **2.x** (`opencode --version`).
- Node **22.18+** for the helper CLI (the plugin itself runs inside OpenCode's Bun runtime).
- A Google account with Antigravity access, or a paid Code Assist Standard/Enterprise
  subscription for the Gemini CLI profile.

## OAuth client identity

This repository ships **no Google credentials**. Login needs the installed-app OAuth client
pair of the client whose entitlement you use. Provide it per profile via environment:

```bash
export OPENCODE_ANTIGRAVITY_CLIENT_ID="..."
export OPENCODE_ANTIGRAVITY_CLIENT_SECRET="..."
```

or in the plugin options:

```jsonc
"options": {
  "oauth": {
    "antigravity": { "clientId": "...", "clientSecret": "..." }
  }
}
```

The Gemini CLI profile uses `OPENCODE_GEMINI_SUB_CLIENT_ID` /
`OPENCODE_GEMINI_SUB_CLIENT_SECRET` (or `options.oauth["gemini-cli"]`). Without these values
login fails with a clear message. Obtaining a compatible identity is your responsibility; see
[`LEGAL.md`](LEGAL.md).

## Install

Clone the repository somewhere stable:

```bash
git clone https://github.com/officialPlocki/opencode-gemini-sub.git ~/.local/share/opencode-gemini-sub-src
cd ~/.local/share/opencode-gemini-sub-src
npm install --omit=dev
```

Add it to the **global** OpenCode config (`~/.config/opencode/opencode.json`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/home/you/.local/share/opencode-gemini-sub-src",
      "options": { "profiles": ["antigravity"] }
    }
  ]
}
```

Reload OpenCode (`/reload`), then run `/models` and pick an `antigravity/...` model.

> [!NOTE]
> OpenCode caches plugin modules by path. After updating the code, bump the version and
> install into a versioned directory (`npm run install:local` does this) or restart the
> service, otherwise the old module stays loaded.

## Sign in

```text
/antigravity-login
```

A browser opens (the URL is also posted into the session). Use a browser on the same machine:
the OAuth callback is a loopback port.

Headless machines:

```bash
node bin/gemini-sub.js login --profile antigravity
```

The CLI prints the URL and waits for the redirect. Credentials are shared with the plugin.

Other commands:

```bash
node bin/gemini-sub.js status  --profile antigravity --quota
node bin/gemini-sub.js quota   --profile antigravity
node bin/gemini-sub.js models  --profile antigravity
node bin/gemini-sub.js logout  --profile antigravity
```

For the paid Code Assist profile use `--profile gemini-cli` and `/gemini-login`.

## Usage

1. Run `/models` and choose a model, e.g. `antigravity/gemini-3.8-flash-low`.
2. Work as usual. Tool calls, subagents and streaming are handled by OpenCode.
3. Open the sidebar to see the remaining 5-hour and weekly limits of the active pool:

```text
GEMINI USAGE
Gemini Models
▶ ready
5h ██████  98% frei · 4h22
1w ██████ 100% frei · 6d23h
```

While a request is parked on a quota window:

```text
⏸ waiting 1m · 18:07
```

The panel is visible whenever one of the plugin's models is selected — idle or running. It
disappears when you switch to a model from another provider.

### Commands and tools

| Command / tool | Purpose |
| --- | --- |
| `/antigravity-login` · `/antigravity-logout` | Sign in/out of the Antigravity profile |
| `/gemini-login` · `/gemini-logout` | Same for the Gemini CLI profile (if enabled) |
| `/gemini-status` | Accounts, projects, tiers, limits, gate state, unavailable models |
| `/gemini-models` | Models exposed by each profile |
| `/gemini-autocontinue on\|off` | Toggle waiting for a quota reset at runtime |
| `gemini_quota` (tool) | Machine-readable status for agents |

## Auto-continue

Enabled by default. On a quota or rate-limit error the proxy does **not** forward the 429:

1. classifies the error (Google RPC `RetryInfo`, `QuotaFailure`, `Retry-After`, prose hints);
2. resolves the reset from `retrieveUserQuotaSummary` (5h/weekly) or the error itself;
3. parks all in-flight requests on a shared gate until reset + a small buffer;
4. keeps the SSE connection alive with comment frames;
5. retries the identical envelope, so the agent loop and tool state survive.

Terminal cases are reported immediately: spending caps, `limit: 0`, a reset beyond
`maxQuotaWaitMs`, or an ineligible account.

Runtime toggle (not persisted):

```text
/gemini-autocontinue off
/gemini-autocontinue on
```

Persistent default:

```jsonc
{ "options": { "autoContinue": false } }
```

## Configuration

```jsonc
{
  "plugins": [
    {
      "package": "/home/you/.local/share/opencode-gemini-sub-src",
      "options": {
        "profiles": ["antigravity"],
        "autoContinue": true,
        "maxQuotaWaitMs": 86400000,
        "keepAliveMs": 15000,
        "concurrency": 2,
        "antigravityVersion": "2.24.0",
        "models": [{ "id": "gemini-3-flash", "context": 1048576 }]
      }
    }
  ]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `profiles` | `["antigravity","gemini-cli"]` | Enabled connection profiles |
| `autoContinue` | `true` | Wait for the quota reset instead of returning the 429 |
| `maxQuotaWaitMs` | `86400000` (24 h) | Longest accepted wait; `0` = unlimited |
| `keepAliveMs` | `15000` | SSE comment interval while parked |
| `concurrency` | `2` | Max parallel upstream requests per profile |
| `antigravityVersion` | `2.24.0` | Hub version reported in the User-Agent |
| `antigravityUseLegacyHeaders` | `false` | Add older `X-Goog-Api-Client`/`Client-Metadata` headers |
| `endpoint` | per profile | Override the backend host (tests/proxies) |
| `projectId` | resolved | Force a Cloud project |
| `models` | built-in + discovery | Add or override model metadata |
| `dataDir` | `~/.local/share/opencode-gemini-sub` | Credential directory |
| `telemetry` | `false` | Send usage metrics like the original client |
| `mock` | `false` | Canned responses, development only |
| `debug` | `false` | Log proxy decisions |

Client identity is configured through the environment variables or `oauth` options described
in [OAuth client identity](#oauth-client-identity). No defaults are shipped.

## Models

Antigravity models are discovered per account (`fetchAvailableModels`). Typical ids:

```
gemini-3.8-flash-high | -medium | -low | -tiered
gemini-3.5-flash-lite | gemini-3.1-flash-lite | gemini-3-flash
claude-sonnet-4-6 | claude-opus-4-6-thinking | gpt-oss-120b-medium
```

Interna (`chat_*`, `tab_*`), aliases (`gemini-2.5-*`), image and disabled entries are filtered.
Availability is account-specific: Google serves different ids to different plans, and models
such as `gemini-4-argon-disabled` stay hidden until the backend enables them.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Not signed in` | `/antigravity-login` |
| `redirect_uri_mismatch` | Google rejected the loopback callback; check the exact error page |
| `UNSUPPORTED_CLIENT` | Gemini CLI profile: Google disabled the individual tier; use Antigravity or a paid project |
| `no Cloud project` after onboarding | Set `GOOGLE_CLOUD_PROJECT` to a project with the Gemini for Google Cloud API enabled |
| Model missing | Not in your account's inventory, or filtered as internal/disabled |
| `maxQuotaWaitMs` error | Raise the limit or retry later |
| Panel shows stale numbers | It refreshes via RPC every 2.5 s; `/gemini-status` forces a quota lookup |

Server logs contain `[gemini-sub] ...` lines. Set `debug: true` for per-request decisions.

## Security & privacy

- OAuth tokens are stored locally in `~/.local/share/opencode-gemini-sub/*.json` with mode `0600`.
- No analytics, no telemetry by default, no third-party servers. Requests go to Google only.
- The loopback proxy binds `127.0.0.1` and uses a random secret path segment.
- Treat the credential files like passwords. Revoke access from your Google account if in doubt.

See [`SECURITY.md`](SECURITY.md) for reporting and details.

## Disclaimer

No warranty, guarantee or representation is made regarding the information in this repository
(including `LEGAL.md`). It is general information for users, not legal advice, and may be
incomplete or outdated. Obtain independent legal advice for your situation.

To the maximum extent permitted by applicable law, the authors and contributors accept **no
liability** for any direct, indirect, incidental, special, consequential or punitive damages,
loss of data, loss of profits, business interruption, account restrictions, suspensions,
terminations, billing charges or other losses arising from the use of or inability to use this
software — even if advised of the possibility of such damages. You use it at your own risk and
are solely responsible for compliance with Google's terms and applicable law.

<details>
<summary>Haftungsausschluss (Deutsch)</summary>

Die in diesem Repository enthaltenen Informationen – insbesondere in `LEGAL.md` – dienen
ausschließlich der allgemeinen Orientierung und sind keine Rechtsberatung. Für Richtigkeit,
Vollständigkeit, Aktualität und Eignung wird keine Gewähr übernommen.

Soweit gesetzlich zulässig, wird keine Haftung für Schäden, Datenverluste, entgangenen Gewinn,
Betriebsunterbrechungen, Kontosperren, Kontokündigungen, Abrechnungen oder sonstige Nachteile
übernommen, die aus der Nutzung oder Nichtnutzung dieser Software entstehen – auch bei
Kenntnis der Möglichkeit solcher Schäden. Die Nutzung erfolgt auf eigenes Risiko.

</details>

## Legal

This project is an independent, clean-room implementation. No Google source code is copied or
vendored. It is not affiliated with Google or the OpenCode project, and it comes with no
warranty. Using it may violate Google's terms and can lead to account restrictions.

See [`LEGAL.md`](LEGAL.md) for what the plugin does with your account, what Google may do, and
the liability terms. Nothing in this repository is legal advice.

## Development

```bash
npm install
npm test          # protocol, profiles, quota, proxy, envelopes
npm run typecheck
npm run install:local   # sync into ~/.local/share/opencode-gemini-sub/<version>
```

The test suite covers both envelope dialects, `retrieveUserQuotaSummary` parsing with a
per-model fallback, error classification, quota park/resume and the loopback proxy. End-to-end
validation in OpenCode uses `mock: true`:

```bash
opencode models | grep antigravity
opencode run --model antigravity/gemini-3-flash "hello"
opencode run --auto --model antigravity/gemini-3-flash '[[tool:read:{"path":"/etc/hostname"}]]'
```

## Layout

```
src/index.ts        plugin: providers, commands, tool, catalogue, RPC
src/tui.tsx         sidebar panel
src/proxy.ts        loopback Gemini REST server + quota policy
src/codeassist.ts   Cloud Code Assist client (both dialects)
src/profiles.ts     OAuth clients, hosts, headers, envelopes, fallback models
src/oauth.ts        Google OAuth loopback flow
src/credentials.ts  per-profile credential store + refresh
src/errors.ts       Google RPC error classification
src/sse.ts          envelope <-> Gemini SSE translation
docs/PROTOCOL.md    reverse-engineered protocol notes
```

## License

MIT — see [`LICENSE`](LICENSE).
