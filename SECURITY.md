# Security policy

## Supported versions

The current `0.2.x` line receives fixes. Older versions may break when Google changes the
protocol and are not supported.

## Reporting a vulnerability

Please report security issues privately:

* open a **private security advisory** on the repository (GitHub → Security → Advisories), or
* contact the maintainer through the repository's listed contact channel.

Do not open a public issue for credential leaks, auth bypasses or local privilege issues.
Include reproduction steps, affected version and, if relevant, a redacted log excerpt.

## Credential handling

* OAuth access and refresh tokens are stored as JSON under
  `~/.local/share/opencode-gemini-sub/` (or the configured `dataDir`), created with mode `0600`.
* The files are never uploaded by the plugin. There is no analytics or telemetry code path.
* The optional `telemetry` setting sends usage metrics to Google like the original client; it
  is off by default and never includes prompts or credentials.
* The loopback proxy listens on `127.0.0.1` with an ephemeral port and a random path segment.
  It is not reachable from other hosts.
* The helper CLI shares the same credential files. Run it only as the user who owns them.

## Revoking access

Sign out with `/antigravity-logout` (or `node bin/gemini-sub.js logout --profile antigravity`)
and revoke the application's access from your Google account security settings. Deleting the
credential file is enough on the local side.

## Scope

This plugin is an unofficial client. Reports about Google's service behaviour, quotas or
account eligibility are not vulnerabilities in this project.
