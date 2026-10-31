import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "../src/index.ts";

test("plugin entrypoint defines the expected shape", () => {
  assert.equal(typeof plugin, "object");
  assert.equal(plugin.id, "gemini-sub");
  assert.equal(typeof plugin.setup, "function");
});
