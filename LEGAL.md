# Legal notice and risk assessment

This document is a plain-language risk summary, **not legal advice**. If you plan to publish,
redistribute or monetize this project, consult a lawyer qualified in your jurisdiction
(software, contract and trademark law).

## Not affiliated with Google

This is an independent project. It is not endorsed by, affiliated with, or sponsored by Google
or the OpenCode project. "Gemini", "Google", "Antigravity" and related marks belong to their
owners and are used only descriptively. No Google logos or brand assets are included.

## What this software does

It emulates the network behaviour of two Google clients:

* the **Antigravity** client (consumer Gemini/Claude/GPT-OSS access), and
* the **Gemini CLI / Code Assist** client (organization-backed Code Assist).

It authenticates with the user's own Google account through OAuth and sends requests to
Google's Cloud Code Assist backend. It reproduces the wire protocol from observation; no
Google source code is copied, vendored or transpiled.

## No credentials are distributed

This repository contains no Google OAuth client id or secret. Users supply a compatible
installed-app client identity themselves (environment or plugin options). Distributing such
credentials would be a separate policy problem; the project deliberately avoids it.

## The central conflict

The OAuth application identity used for login belongs to Google's clients. Google's OAuth
policies and product terms generally prohibit using another application's client identity, and
several Google terms restrict access through unofficial clients or attempts to circumvent
usage limits. Google has blocked such clients before and can do so again.

Because the subscription entitlement is tied to that client identity, there is no
configuration that makes this both functional and clearly permitted. A user-supplied OAuth
client does not receive the same entitlements.

## Risks

| Risk | Likelihood | Notes |
| --- | --- | --- |
| Account restriction or termination | Medium to high | Google may flag the traffic as abuse |
| Client identity blocked | High over time | The `UNSUPPORTED_CLIENT` response for the Gemini CLI individual tier is an example |
| Takedown request (terms/trademark) | Medium if the project is popular | GitHub responds to valid complaints |
| Copyright claim | Low | Clean-room implementation; protocol facts are not protected expression |
| Patent claim | Low | No known relevant patents for this wrapper |
| Trademark confusion | Medium | Avoid names/logos that imply official status |
| User harm from credential handling | Low if audited | Tokens are stored locally with mode 0600; no telemetry |

## If you publish

* Use a neutral project name. Do not use Google logos or imply endorsement.
* Keep the disclaimer and the warning visible in the README and in the plugin output.
* Do not market it as free access, a limit bypass or a cheat.
* Do not sell support or licenses for it.
* Keep telemetry off by default and never transmit credentials.
* Be prepared to make the repository private or remove it in response to a complaint.
* Do not connect it to a company identity without legal review.

## No warranty for this assessment

This risk assessment is general information, not legal advice. No warranty, guarantee or
representation is made regarding its accuracy, completeness, timeliness or applicability to your
situation. Obtain independent legal advice before relying on it.

## Disclaimer and limitation of liability

To the maximum extent permitted by applicable law, the authors and contributors accept **no
liability** for any direct, indirect, incidental, special, consequential or punitive damages,
loss of data, loss of profits, business interruption, account restrictions, suspensions,
terminations, billing charges or other losses arising from the use of or inability to use this
software, even if advised of the possibility of such damages. You use it at your own risk and
are solely responsible for compliance with Google's terms and applicable law.

### Haftungsausschluss (Deutsch)

Die in diesem Repository enthaltenen Einschätzungen – insbesondere in dieser Datei – dienen
ausschließlich der allgemeinen Information und sind keine Rechtsberatung. Für Richtigkeit,
Vollständigkeit, Aktualität und Eignung wird keine Gewähr übernommen. Ziehen Sie eigenen
Rechtsrat hinzu.

Soweit gesetzlich zulässig, wird keine Haftung für Schäden, Datenverluste, entgangenen Gewinn,
Betriebsunterbrechungen, Kontosperren, Kontokündigungen, Abrechnungen oder sonstige Nachteile
übernommen, die aus der Nutzung oder Nichtnutzung dieser Software entstehen – auch bei
Kenntnis der Möglichkeit solcher Schäden. Die Nutzung erfolgt auf eigenes Risiko.
