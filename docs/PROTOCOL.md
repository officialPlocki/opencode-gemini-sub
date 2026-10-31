# Reverse-engineered protocol notes

This document describes the Code Assist ("cloudcode-pa") backend as it is used by subscription-backed Gemini clients, and how `opencode-gemini-sub` maps OpenCode's Gemini REST traffic onto it.

## Clean-room statement

Everything here was derived from observable HTTP behaviour and from public documentation of Google RPC error types. No Google source file is copied, vendored, or transpiled. The implementation in `src/` is original.

Two literals must match the original client because the backend validates them:

* the public OAuth client id/secret pair of the installed Gemini CLI application (a public installed-app credential, not a cryptographic secret),
* the client metadata enum values (`pluginType: "GEMINI"`, …).

Both are configurable (`OPENCODE_GEMINI_SUB_CLIENT_ID`, `OPENCODE_GEMINI_SUB_CLIENT_SECRET`) and are protocol identifiers, not code.

## Endpoints

| Purpose | Method | URL |
| --- | --- | --- |
| Tier/project negotiation | POST | `https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` |
| First-time onboarding | POST | `…/v1internal:onboardUser` |
| Onboarding long-running operation | GET | `…/v1internal/<operationName>` |
| Streaming generation | POST | `…/v1internal:streamGenerateContent?alt=sse` |
| Non-streaming generation | POST | `…/v1internal:generateContent` |
| Token counting | POST | `…/v1internal:countTokens` |
| Quota buckets | POST | `…/v1internal:retrieveUserQuota` |
| Admin controls | POST | `…/v1internal:fetchAdminControls` |
| Usage metrics (opt-in) | POST | `…/v1internal:recordCodeAssistMetrics` |

All calls are `POST` + JSON except operations, with `Authorization: Bearer <oauth access token>`.

## OAuth

* Authorization: `https://accounts.google.com/o/oauth2/v2/auth`, response type `code`, PKCE `S256`, `access_type=offline`, `prompt=consent`.
* Redirect: `http://127.0.0.1:<ephemeral>/oauth2callback` (installed-app loopback).
* Scopes: `cloud-platform`, `userinfo.email`, `userinfo.profile`.
* Token exchange/refresh: `https://oauth2.googleapis.com/token` with `grant_type=authorization_code|refresh_token`.
* Refresh tokens are long-lived; access tokens expire after ~1 h. The client refreshes 60 s early and on any `401`.

## Request envelope

OpenCode speaks the ordinary Gemini REST API:

```http
POST /v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse
{ "contents": [...], "tools": [...], "systemInstruction": {...}, "generationConfig": {...} }
```

The proxy converts it to:

```jsonc
{
  "model": "gemini-2.5-pro",          // bare id, no "models/" prefix
  "project": "<cloudaicompanionProject>",
  "user_prompt_id": "<uuid>",
  "request": {
    "contents": [...],                 // unchanged, Gemini Content[]
    "systemInstruction": {...},        // unchanged
    "tools": [{ "functionDeclarations": [...] }],
    "toolConfig": {...},
    "generationConfig": {...},
    "safetySettings": [...],
    "session_id": "<stable per plugin instance>"
  }
}
```

`request` is a standard `GenerateContentRequest`; only `session_id` is added. Fields unknown to the backend are stripped before wrapping (transport-only keys such as a body-level `model`).

`loadCodeAssist` expects:

```jsonc
{
  "cloudaicompanionProject": "<optional project>",
  "metadata": { "ideType": "IDE_UNSPECIFIED", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI", "duetProject": "<project>" }
}
```

and returns `currentTier`, `paidTier`, `allowedTiers`, `cloudaicompanionProject`, `ineligibleTiers`. If no project is returned and a default tier exists, `onboardUser` is called and the returned operation is polled until `done`.

## Response format

Non-streaming:

```json
{ "response": { "candidates": [...], "usageMetadata": {...} }, "traceId": "..." }
```

Streaming (`text/event-stream`), one JSON object per event:

```text
data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Hi"}]}}]},"traceId":"…"}
```

The proxy removes the outer `response` key and re-emits plain Gemini events, so OpenCode's Google provider sees exactly what it expects, including `functionCall`, `functionResponse`, `thoughtSignature` and `usageMetadata`.

## Errors and quota

Errors are Google RPC envelopes:

```jsonc
{
  "error": {
    "code": 429,
    "message": "…",
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      { "@type": "type.googleapis.com/google.rpc.QuotaFailure", "violations": [{ "quotaId": "…PerDay…" }] },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "3421s" },
      { "@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "MODEL_CAPACITY_EXHAUSTED" }
    ]
  }
}
```

Classification used by `src/errors.ts`:

| Signal | Decision |
| --- | --- |
| `401` | refresh token, retry once |
| `403` + `VALIDATION_REQUIRED` | terminal, tells the user to finish Google's check |
| `RetryInfo.retryDelay`, `Retry-After`, "retry in Xs" | wait that long |
| `QuotaFailure` id containing `PerDay`/`Daily` | quota window; wait for `retrieveUserQuota` reset |
| long delay (> 10 min) | quota window |
| `ErrorInfo.reason` `MODEL_CAPACITY_EXHAUSTED/EXCEEDED` | retry with backoff |
| "spending cap", "billing limit", `limit: 0` | terminal |
| bare `429` | retry after 60 s |

Quota reset resolution order:

1. timestamp in the error,
2. `RetryInfo`/`Retry-After`/prose delay,
3. `retrieveUserQuota` → earliest `resetTime` of exhausted buckets (fallback: any bucket),
4. 60 s fallback.

`retrieveUserQuota` returns:

```json
{ "buckets": [{ "modelId": "gemini-2.5-pro", "remainingFraction": 0, "resetTime": "2026-01-01T00:00:00Z" }] }
```

## Client identity

Observed header shape:

```text
User-Agent: GeminiCLI/<version>/<model> (<platform>; <arch>; <surface>)
Content-Type: application/json
Authorization: Bearer <token>
```

The plugin emits the same shape with `{model}` substituted, overridable through options. No other fingerprinting tricks are used.

## What is intentionally not emulated

* `recordCodeAssistMetrics` is off by default (opt-in via `telemetry`). Sending telemetry is not required for the protocol to work.
* Embedding, image/video/speech generation and other non-chat surfaces are not proxied. The subscription entitlement for those is separate.
* Model discovery: the backend has no usable pre-conversation listing here, so the catalogue is local and configurable.

## Confidence and limits

The request/response shapes above are verified against the backend's documented Google RPC types and against real client traffic patterns. They are **not** verified against a live subscription in this repository's test suite, because that requires a personal Google account. The proxy, SSE translation, quota gate and error classification are covered by automated tests with a fake backend, and the whole path is exercised end-to-end in OpenCode's `mock` mode, including a real tool-call round trip.

---

# Antigravity profile

Google's Antigravity client uses the same Cloud Code Assist transport as the Gemini CLI, but with its own OAuth application, host, headers and envelope. The plugin implements it as a separate profile.

## OAuth

| | |
| --- | --- |
| Client id | supplied by the user (installed-app identity of the official client) |
| Callback | `http://127.0.0.1:<ephemeral>/oauth-callback` |
| Scopes | `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`, `experimentsandconfigs`, `openid` |

`cclog` and `experimentsandconfigs` are Antigravity-specific; without them the token is not accepted by the daily host.

## Host

`https://daily-cloudcode-pa.googleapis.com` for every call (`loadCodeAssist`, `onboardUser`, `fetchAvailableModels`, `generateContent`, `streamGenerateContent`). Consumer entitlements are bound to this host; mixing it with the production host can produce mismatched tiers.

## Headers

Current Hub style (default):

```http
User-Agent: antigravity/hub/2.24.0 (aidev_client; os_type=linux; arch=x64; cl=1000335682)
Authorization: Bearer <token>
Content-Type: application/json
```

Older clients also send:

```http
X-Goog-Api-Client: google-cloud-sdk vscode_cloudshelleditor/0.1
Client-Metadata: {"ideType":"ANTIGRAVITY","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}
```

Set `antigravityUseLegacyHeaders: true` to add those. Onboarding calls append `google-api-nodejs-client/10.3.0` to the User-Agent and use `X-Goog-Api-Client: gl-node/22.21.1`, matching the Hub's control-plane requests.

The Hub version is configurable (`antigravityVersion`). Newer models are gated on a minimum Hub version, so keep it current.

## Envelope

```jsonc
{
  "project": "<cloudaicompanionProject>",
  "model": "gemini-3-flash",
  "request": { "contents": [...], "systemInstruction": {...}, "tools": [...], "generationConfig": {...} },
  "userAgent": "antigravity",
  "requestId": "<uuid per request>"
}
```

Differences from the CLI dialect: no `user_prompt_id`, no `session_id`, `requestId` is used for retry de-duplication, and `userAgent` identifies the client.

## Project discovery

`loadCodeAssist` with:

```json
{ "metadata": { "ideType": "ANTIGRAVITY", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI" } }
```

The response carries `allowedTiers`, `currentTier`, `paidTier` and `cloudaicompanionProject`. If no project is returned, `onboardUser` is called with the default tier (`cloudaicompanionProject` omitted for `free-tier`), polled until `done`, then `loadCodeAssist` is retried once.

## Model discovery

`POST /v1internal:fetchAvailableModels` with `{ "project": "<id>" }` returns:

```jsonc
{
  "models": {
    "gemini-3-flash": {
      "displayName": "Gemini 3 Flash",
      "maxTokens": 1048576,
      "maxOutputTokens": 65536,
      "supportsImages": true,
      "supportsThinking": true,
      "isInternal": false,
      "quotaInfo": { "remainingFraction": 0.92, "resetTime": "2026-10-31T19:29:46Z" }
    }
  }
}
```

Rules applied by the plugin:

* drop `isInternal: true`, `chat_*` ids, retired ids (`gemini-2.5-pro`, `tab_flash_lite_preview`);
* use `maxTokens` / `maxOutputTokens` as context / output limits;
* the same `quotaInfo` drives the auto-continue reset lookup, so no separate quota call is needed.

Some advertised ids are not actually serviceable. `gemini-3.1-pro-high` returns a detail-less 400; the Hub's working high-effort route is `gemini-pro-agent`, which the fallback catalogue uses. `gemini-3.5-flash-high` maps to `gemini-3-flash-agent`.

## Errors

Same Google RPC envelope as the CLI profile. `429 RESOURCE_EXHAUSTED` with `RetryInfo.retryDelay` or a per-model `quotaInfo.resetTime` feeds the same gate described above.

## Confidence

The Antigravity profile is reconstructed from public protocol documentation and independent client implementations, then exercised end to end against OpenCode with a mock backend. A live account is required to validate entitlements and model inventory, because those are account-specific.


## Account limits: `retrieveUserQuotaSummary`

`fetchAvailableModels` only carries a per-model 5-hour fraction. The 5-hour
and weekly limits shown in the Antigravity usage page come from a separate
call:

```http
POST /v1internal:retrieveUserQuotaSummary
{ "project": "<cloudaicompanionProject>" }
```

```jsonc
{
  "groups": [
    {
      "displayName": "Gemini Models",
      "buckets": [
        { "bucketId": "gemini-weekly", "window": "weekly", "remainingFraction": 0.997, "resetTime": "2026-11-07T16:45:50Z" },
        { "bucketId": "gemini-5h",     "window": "5h",     "remainingFraction": 0.990, "resetTime": "2026-10-31T21:45:50Z" }
      ]
    },
    {
      "displayName": "Claude and GPT models",
      "buckets": [
        { "bucketId": "3p-weekly", "window": "weekly", "remainingFraction": 0.990, "resetTime": "2026-11-07T16:46:05Z" },
        { "bucketId": "3p-5h",     "window": "5h",     "remainingFraction": 0.979, "resetTime": "2026-10-31T21:46:05Z" }
      ]
    }
  ]
}
```

There are therefore two pools (Gemini, Claude/GPT), each with a 5-hour and a
weekly window. The plugin keys them as `gemini` and `3p`, shows the active
model's pool in the sidebar, and uses the same data for the auto-continue
reset lookup (falling back to per-model `quotaInfo` if the summary endpoint is
unavailable).
