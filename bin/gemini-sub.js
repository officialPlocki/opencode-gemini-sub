#!/usr/bin/env node
/**
 * Companion CLI for environments where the OpenCode TUI is not the best place
 * to finish a browser login (SSH, containers, CI boxes). It shares the
 * credential files with the plugin.
 *
 * Usage:
 *   opencode-gemini-sub login    [--profile antigravity|gemini-cli]
 *   opencode-gemini-sub status   [--profile ...] [--quota]
 *   opencode-gemini-sub quota    [--profile ...]
 *   opencode-gemini-sub models   [--profile ...]
 *   opencode-gemini-sub logout   [--profile ...]
 *   opencode-gemini-sub import   [--profile gemini-cli]
 */

import { join } from "node:path";
import { CodeAssistClient } from "../src/codeassist.ts";
import {
  CredentialManager,
  dataDirectory,
  importGeminiCLICredentials,
} from "../src/credentials.ts";
import { classifyError, describeError } from "../src/errors.ts";
import { OAUTH_CLIENT_ENV } from "../src/constants.ts";
import { login } from "../src/oauth.ts";
import { createProfiles } from "../src/profiles.ts";

const argv = process.argv.slice(2);
const profileFlag = argv.indexOf("--profile");
const profileID = profileFlag >= 0 ? argv.splice(profileFlag, 2)[1] : "antigravity";
const [command = "status", ...rest] = argv;

const profile = createProfiles().find((entry) => entry.id === profileID);
if (!profile) {
  console.error(`Unknown profile "${profileID}". Use "antigravity" or "gemini-cli".`);
  process.exit(2);
}

function line(text = "") {
  process.stdout.write(`${text}\n`);
}

function fmtTime(value) {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.toISOString()} (${Math.max(0, Math.round((date.getTime() - Date.now()) / 60000))} min)`;
}

const credentials = new CredentialManager({
  path: join(dataDirectory(), profile.credentialsFile),
});
await credentials.bootstrap({
  importGeminiCLI: profile.id === "gemini-cli",
});

const client = new CodeAssistClient({ credentials, profile });

line(`Profile: ${profile.name} (${profile.providerID})`);

switch (command) {
  case "login": {
    if (!profile.oauth.clientId || !profile.oauth.clientSecret) {
      const env = OAUTH_CLIENT_ENV[profile.id];
      line(`OAuth client identity for ${profile.name} is missing.`);
      line(`Set ${env.id} and ${env.secret}, or add options.oauth.${profile.id} to the plugin configuration.`);
      process.exitCode = 1;
      break;
    }
    const result = await login({
      clientId: profile.oauth.clientId,
      clientSecret: profile.oauth.clientSecret,
      scopes: profile.oauth.scopes,
      callbackPath: profile.oauth.callbackPath,
      onAuthUrl: (url) => {
        line("Open this URL to authorize OpenCode:");
        line(url);
        line();
        line("Waiting for the browser redirect...");
      },
    });
    await credentials.setCredentials(result);
    line(`Stored credentials in ${credentials.path}`);
    try {
      const project = await client.ensureProject({ refresh: true });
      line(`Project: ${project.projectId}`);
      line(`Tier:    ${project.tierName ?? project.tierId ?? "unknown"}${project.paid ? " (paid)" : ""}`);
      const inventory = await client.listAvailableModels(project.projectId).catch(() => undefined);
      if (inventory?.models) line(`Models:  ${Object.keys(inventory.models).length} available`);
    } catch (cause) {
      line(`Warning: ${cause instanceof Error ? cause.message : cause}`);
    }
    break;
  }

  case "import": {
    const imported = await importGeminiCLICredentials();
    if (!imported) {
      line("No Gemini CLI credentials found (~/.gemini/oauth_creds.json).");
      process.exitCode = 1;
      break;
    }
    await credentials.setCredentials(imported);
    line(`Imported credentials into ${credentials.path}`);
    break;
  }

  case "logout": {
    await credentials.signOut();
    line("Credentials removed.");
    break;
  }

  case "quota": {
    if (!credentials.signedIn) {
      line("Not signed in. Run `opencode-gemini-sub login`.");
      process.exitCode = 1;
      break;
    }
    try {
      const limits = await client.quotaLimits();
      for (const limit of limits) {
        const fraction = limit.fraction < 0 ? "?" : `${Math.round(limit.fraction * 100)}%`;
        line(
          `${limit.group} · ${limit.window}: ${fraction} remaining, reset ${fmtTime(
            limit.resetTime ? Date.parse(limit.resetTime) : undefined,
          )}`,
        );
      }
      if (!limits.length) line("No limits returned.");
    } catch (cause) {
      if (cause && typeof cause === "object" && "status" in cause) {
        line(describeError(classifyError(Number(cause.status), {}, String(cause.body ?? ""))));
      } else {
        line(cause instanceof Error ? cause.message : String(cause));
      }
      process.exitCode = 1;
    }
    break;
  }

  case "models": {
    if (profile.discovery && credentials.signedIn) {
      try {
        const inventory = await client.listAvailableModels();
        for (const [id, info] of Object.entries(inventory.models ?? {})) {
          if (info.isInternal || id.startsWith("chat_")) continue;
          line(`${id.padEnd(32)} ${info.displayName ?? ""}`);
        }
        break;
      } catch (cause) {
        line(`Discovery failed, showing built-in list: ${cause instanceof Error ? cause.message : cause}`);
      }
    }
    for (const model of profile.models) {
      line(`${model.id.padEnd(32)} ${model.name}${model.tools ? "" : " (no tools)"}`);
    }
    break;
  }

  case "status":
  default: {
    line(`Data directory: ${dataDirectory()}`);
    line(`Signed in:      ${credentials.signedIn ? "yes" : "no"}`);
    if (credentials.credentials?.email) line(`Account:        ${credentials.credentials.email}`);
    if (credentials.credentials?.expiresAt) {
      line(`Access token:   expires ${fmtTime(credentials.credentials.expiresAt)}`);
    }
    if (credentials.project) {
      line(`Project:        ${credentials.project.projectId}`);
      line(`Tier:           ${credentials.project.tierName ?? credentials.project.tierId ?? "unknown"}`);
    }
    if (rest.includes("--quota") && credentials.signedIn) {
      try {
        const limits = await client.quotaLimits();
        for (const limit of limits) {
          const fraction = limit.fraction < 0 ? "?" : `${Math.round(limit.fraction * 100)}%`;
          line(
            `${limit.group} · ${limit.window}: ${fraction} reset ${fmtTime(
              limit.resetTime ? Date.parse(limit.resetTime) : undefined,
            )}`,
          );
        }
      } catch (cause) {
        line(`Quota lookup failed: ${cause instanceof Error ? cause.message : cause}`);
      }
    }
    break;
  }
}
