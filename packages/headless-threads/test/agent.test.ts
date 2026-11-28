import assert from "node:assert/strict";
import test from "node:test";

import { createHeadlessThreadClient, HeadlessThreadError, type HeadlessFetch } from "../src/index.js";

const WORKSPACE = "ws_1";
const THREAD = "ses_thread1";
const AGENT = "restricted-agent";
const MODEL = { providerId: "openai", modelId: "gpt-default" };

type Call = { method: string; path: string; body: Record<string, unknown> | undefined };

/** A fake OpenWork server, recording every request the client makes. */
function fakeServer(input: { engine: "v1" | "v2"; sessionAgent?: string; createdAgent?: string | null }) {
  const calls: Call[] = [];
  const workspace = `/workspace/${WORKSPACE}`;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const fetch: HeadlessFetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ method, path, body });
    if (method === "GET" && path === `${workspace}/default-model`) return json({ model: { providerID: "openai", modelID: "gpt-default" } });
    if (input.engine === "v2") {
      const base = `${workspace}/opencode2/api/session`;
      const session = `${base}/${THREAD}`;
      if (method === "POST" && path === base) {
        const agent = input.createdAgent === undefined ? body?.agent : input.createdAgent;
        return json({ data: { id: THREAD, title: body?.title, ...(typeof agent === "string" ? { agent } : {}) } });
      }
      if (method === "GET" && path === session) {
        return json({ data: { id: THREAD, model: { providerID: "openai", id: "gpt-default" }, ...(input.sessionAgent ? { agent: input.sessionAgent } : {}) } });
      }
      if (method === "GET" && path === `${session}/message`) return json({ data: [{ id: "msg_0", role: "user", text: "earlier" }], cursor: { next: null } });
      if (method === "POST" && [`${session}/agent`, `${session}/model`, `${session}/prompt`].includes(path)) return json({ data: {} });
    } else {
      const base = `${workspace}/opencode/session`;
      const session = `${base}/${THREAD}`;
      if (method === "POST" && path === base) return json({ id: THREAD, title: body?.title });
      if (method === "GET" && path === `${session}/message`) return json([{ info: { id: "msg_0", role: "user" }, parts: [] }]);
      if (method === "POST" && path === `${session}/prompt_async`) return new Response(null, { status: 204 });
    }
    return json({ message: `Unexpected ${method} ${path}` }, 500);
  };
  const client = createHeadlessThreadClient({ baseUrl: "http://openwork.test", workspaceId: WORKSPACE, token: "test-token", engine: input.engine, fetch });
  const find = (method: string, suffix: string) => calls.filter((call) => call.method === method && call.path.endsWith(suffix));
  return { client, calls, find };
}

test("v1: a thread created with an agent names it on create and on its first prompt", async () => {
  const server = fakeServer({ engine: "v1" });
  await server.client.createThread({ title: "Runner", agent: AGENT, prompt: "go", model: MODEL });
  const [created] = server.find("POST", "/opencode/session");
  assert.equal(created?.body?.agent, AGENT);
  const [prompt] = server.find("POST", "/prompt_async");
  assert.equal(prompt?.body?.agent, AGENT);
});

test("v1: a thread created without an agent sends no agent field", async () => {
  const server = fakeServer({ engine: "v1" });
  await server.client.createThread({ title: "Chat", prompt: "go", model: MODEL });
  const [created] = server.find("POST", "/opencode/session");
  assert.ok(created?.body && !("agent" in created.body));
  const [prompt] = server.find("POST", "/prompt_async");
  assert.ok(prompt?.body && !("agent" in prompt.body));
});

test("v1: every turn sent with an agent names it, a turn without one does not", async () => {
  const server = fakeServer({ engine: "v1" });
  await server.client.sendTurn(THREAD, { prompt: "restricted", agent: AGENT });
  await server.client.sendTurn(THREAD, { prompt: "normal" });
  const prompts = server.find("POST", "/prompt_async").map((call) => call.body ?? {});
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0]?.agent, AGENT);
  assert.ok(!("agent" in (prompts[1] ?? {})));
});

test("v2: a thread created with an agent binds it in the create body", async () => {
  const server = fakeServer({ engine: "v2" });
  await server.client.createThread({ title: "Runner", agent: AGENT, model: MODEL });
  const [created] = server.find("POST", "/opencode2/api/session");
  assert.equal(created?.body?.agent, AGENT);
});

test("v2: a thread created without an agent sends no agent field", async () => {
  const server = fakeServer({ engine: "v2" });
  await server.client.createThread({ title: "Chat", model: MODEL });
  const [created] = server.find("POST", "/opencode2/api/session");
  assert.ok(created?.body && !("agent" in created.body));
});

test("v2: a created session that did not bind the requested agent is refused", async () => {
  const server = fakeServer({ engine: "v2", createdAgent: null });
  await assert.rejects(
    server.client.createThread({ title: "Runner", agent: AGENT, model: MODEL }),
    (error: unknown) => error instanceof HeadlessThreadError && error.code === "agent_not_applied",
  );
  assert.deepEqual(server.find("POST", "/prompt"), []);
});

test("v2: a turn with an agent re-binds a session on another agent before prompting", async () => {
  const server = fakeServer({ engine: "v2", sessionAgent: "build" });
  await server.client.sendTurn(THREAD, { prompt: "restricted", agent: AGENT });
  const order = server.calls.filter((call) => call.method === "POST").map((call) => call.path.split("/").pop());
  assert.deepEqual(order, ["agent", "prompt"]);
  assert.deepEqual(server.find("POST", "/agent")[0]?.body, { agent: AGENT });
  assert.ok(!("agent" in (server.find("POST", "/prompt")[0]?.body ?? {})));
});

test("v2: a turn with the agent a session is already on does not switch it", async () => {
  const server = fakeServer({ engine: "v2", sessionAgent: AGENT });
  await server.client.sendTurn(THREAD, { prompt: "restricted", agent: AGENT });
  assert.deepEqual(server.find("POST", "/agent"), []);
  assert.equal(server.find("POST", "/prompt").length, 1);
});

test("v2: a turn without an agent never touches the session agent", async () => {
  const server = fakeServer({ engine: "v2", sessionAgent: "build" });
  await server.client.sendTurn(THREAD, { prompt: "normal" });
  assert.deepEqual(server.find("POST", "/agent"), []);
  assert.ok(!("agent" in (server.find("POST", "/prompt")[0]?.body ?? {})));
});
