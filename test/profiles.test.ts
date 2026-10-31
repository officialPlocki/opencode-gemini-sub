import assert from "node:assert/strict";
import { test } from "node:test";
import { createProfiles } from "../src/profiles.ts";

test("profiles ship no credentials and accept explicit ones", () => {
  const empty = createProfiles();
  for (const profile of empty) {
    assert.equal(profile.oauth.clientId, "");
    assert.equal(profile.oauth.clientSecret, "");
  }

  const configured = createProfiles({
    clients: { antigravity: { clientId: "client-id", clientSecret: "client-secret" } },
  });
  const antigravity = configured.find((profile) => profile.id === "antigravity");
  assert.equal(antigravity?.oauth.clientId, "client-id");
  assert.equal(antigravity?.oauth.clientSecret, "client-secret");
  const cli = configured.find((profile) => profile.id === "gemini-cli");
  assert.equal(cli?.oauth.clientId, "");
});
