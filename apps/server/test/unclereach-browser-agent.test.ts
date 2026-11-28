import assert from "node:assert/strict";
import test from "node:test";

import { renderOpencodeV2Config } from "../src/managed-opencode-v2.js";
import { server as browserTools } from "../src/opencode-plugins/openwork-chrome-devtools.js";
import { buildOpenworkRuntimeConfigObjectFromSnapshot } from "../src/openwork-runtime-config.js";
import { UNCLEREACH_BROWSER_AGENT, UNCLEREACH_BROWSER_TOOLS } from "../src/unclereach-browser-agent.js";

type Rule = { action: string; resource: string; effect: string };

test("the agent allows exactly the browser_* tools the browser plugin registers", async () => {
  const registered = Object.keys((await browserTools()).tool).filter((name) => name.startsWith("browser_")).sort();
  assert.deepEqual([...UNCLEREACH_BROWSER_TOOLS].sort(), registered);
});

test("v2: the rendered config defines the agent with deny-all then the browser tools", () => {
  const rendered = renderOpencodeV2Config({
    providers: [],
    skills: [],
    contextPluginDirectory: "/plugins/context",
    contextTools: { url: "http://127.0.0.1:1/context", token: "t", browser: { url: "http://127.0.0.1:1/browser", token: "b" } },
    permissions: [{ action: "shell", resource: "*", effect: "ask" }],
  });
  const agents = rendered.agents as Record<string, { permissions: Rule[]; mode?: string; hidden?: boolean }>;
  const agent = agents[UNCLEREACH_BROWSER_AGENT];
  assert.ok(agent, "the restricted agent is defined");
  assert.deepEqual(agent.permissions, [
    { action: "*", resource: "*", effect: "deny" },
    ...UNCLEREACH_BROWSER_TOOLS.map((action) => ({ action, resource: "*", effect: "allow" })),
  ]);
  assert.equal(agent.hidden, true);
  // The deny is agent-scoped: nothing global denies everything.
  const global = rendered.permissions as Rule[];
  assert.ok(!global.some((rule) => rule.action === "*" && rule.effect === "deny"));
  // No other agent is overridden.
  assert.deepEqual(Object.keys(agents), [UNCLEREACH_BROWSER_AGENT]);
});

test("v2: the agent is present even in a minimal config, with no global permissions added", () => {
  const rendered = renderOpencodeV2Config({ providers: [], skills: [] });
  assert.ok((rendered.agents as Record<string, unknown>)[UNCLEREACH_BROWSER_AGENT]);
  assert.equal(rendered.permissions, undefined);
});

test("v1: the runtime config defines the agent with deny-all then the browser tools, scoped to it", () => {
  const config = buildOpenworkRuntimeConfigObjectFromSnapshot({});
  const agents = config.agent as Record<string, { permission: Record<string, unknown>; mode?: string; hidden?: boolean }>;
  const agent = agents[UNCLEREACH_BROWSER_AGENT];
  assert.ok(agent, "the restricted agent is defined");
  assert.deepEqual(agent.permission, {
    "*": "deny",
    ...Object.fromEntries(UNCLEREACH_BROWSER_TOOLS.map((tool) => [tool, "allow"])),
  });
  // The runtime config file is written with sorted keys; the deny must still come first.
  assert.equal(Object.keys(agent.permission).sort()[0], "*");
  assert.equal(agent.hidden, true);
  // The user's default agent and the global permission block are untouched.
  assert.equal(config.default_agent, "openwork");
  assert.ok(!("*" in (config.permission as Record<string, unknown>)));
  assert.ok(!("*" in agents.openwork!.permission));
});
