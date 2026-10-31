# User information and risk notice

This page explains what this plugin does, what it needs from you, and what can happen when you
use it. It is written for people using the software, not as a legal memo, and it is **not legal
advice**. Google's terms and your local law always take precedence over anything written here.

## What this software does

`opencode-gemini-sub` connects OpenCode to Google's Cloud Code Assist backend by emulating the
network behaviour of two Google clients:

* the **Antigravity** client, for consumer Gemini/Claude/GPT-OSS access, and
* the **Gemini CLI / Code Assist** client, for organization-backed Code Assist.

It logs in with your Google account through OAuth and sends your prompts to Google. It does not
proxy your traffic through a third-party server. No Google source code is copied or bundled;
the protocol was reconstructed from observation.

## What you need

* Your **own** Google account. Do not use accounts you are not allowed to use.
* A compatible **OAuth client identity** (client id and secret). This repository ships none;
  you provide it through environment variables or plugin options. Obtaining a compatible
  identity is your responsibility.
* A plan that actually grants the entitlement you expect. Antigravity access is account- and
  plan-dependent. The Gemini CLI profile is rejected for the individual tier
  (`UNSUPPORTED_CLIENT`) and only makes sense for paid Code Assist subscriptions.

## What Google may do

Using an unofficial client is not something Google endorses. In practice this means:

* Google can change, restrict or block the endpoints or client identities at any time.
* Google can rate-limit, suspend or terminate accounts it associates with this kind of traffic.
* Requests can start failing after a client update, a policy change or a rollout.
* Your usage still counts against your plan's limits, and limits can change.

None of this is in the plugin's control, and none of it is a bug in the plugin.

## Your responsibility

* Comply with Google's terms, your plan's conditions and applicable law.
* Keep your credential files private (`~/.local/share/opencode-gemini-sub/`, mode `0600`).
* Do not use the software to attack, scrape, resell or bypass limits for others.
* Accept that you use an unofficial client at your own risk.

## No warranty

The software and every statement in this repository are provided **"as is"**, without warranty
of any kind, express or implied. No guarantee is given for the accuracy, completeness,
timeliness or suitability of the information here or of the software's behaviour. Features may
break when Google changes its services.

## Limitation of liability

To the maximum extent permitted by applicable law, the authors and contributors accept **no
liability** for any direct, indirect, incidental, special, consequential or punitive damages,
loss of data, loss of profits, business interruption, account restrictions, suspensions,
terminations, billing charges or other losses arising from the use of or inability to use this
software — even if advised of the possibility of such damages. You use it at your own risk and
are solely responsible for compliance with Google's terms and applicable law.

### Haftungsausschluss (Deutsch)

Die in diesem Repository enthaltenen Informationen dienen ausschließlich der allgemeinen
Orientierung und sind keine Rechtsberatung. Für Richtigkeit, Vollständigkeit, Aktualität und
Eignung wird keine Gewähr übernommen.

Soweit gesetzlich zulässig, wird keine Haftung für Schäden, Datenverluste, entgangenen Gewinn,
Betriebsunterbrechungen, Kontosperren, Kontokündigungen, Abrechnungen oder sonstige Nachteile
übernommen, die aus der Nutzung oder Nichtnutzung dieser Software entstehen – auch bei
Kenntnis der Möglichkeit solcher Schäden. Die Nutzung erfolgt auf eigenes Risiko.

## Privacy and security

* OAuth tokens stay on your machine in `0600` JSON files.
* No analytics, no telemetry by default, no third-party relays.
* The loopback proxy binds `127.0.0.1` with a random secret path.
* See [`SECURITY.md`](SECURITY.md) for reporting and details.

## If you redistribute

If you fork, mirror or share this software:

* keep this notice and the disclaimer,
* do not add Google credentials to the repository,
* do not present it as official or endorsed by Google,
* and expect that Google may ask for changes or removal.

This project is independent and not affiliated with Google or the OpenCode project.
