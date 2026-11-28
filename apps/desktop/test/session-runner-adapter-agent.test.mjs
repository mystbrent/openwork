import assert from "node:assert/strict"
import test from "node:test"
import { createDesktopSessionAdapter, UNCLEREACH_RUNNER_AGENT } from "../electron/session-runner-adapter.mjs"

const WS = "ws_1"
const SESSION = "ses_runner1"
const BASE = "http://openwork.test"

/**
 * A fake local OpenWork server for one workspace on one engine. Nothing here
 * reaches a real engine or network; every request is recorded.
 */
function fakeLocal({ engine, sessionAgent = undefined, bindsAgent = true }) {
  const calls = []
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
  const fetchImpl = async (url, init = {}) => {
    const { pathname: path } = new URL(url)
    const method = init.method ?? "GET"
    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined
    calls.push({ method, path, body })
    if (path === "/workspaces") return json({ items: [{ id: WS, path: "" }], activeId: WS })
    if (path === "/experimental/engine-v2-preview/status") {
      return engine === "v2" ? json({ enabled: true, chatRouting: true }) : json({ message: "not found" }, 404)
    }
    if (path === `/workspace/${WS}/default-model`) return json({ model: { providerID: "openai", modelID: "gpt-test" } })
    if (engine === "v2") {
      const base = `/workspace/${WS}/opencode2/api/session`
      const session = `${base}/${SESSION}`
      if (method === "POST" && path === base) {
        return json({ data: { id: SESSION, title: body?.title, ...(bindsAgent && body?.agent ? { agent: body.agent } : {}) } })
      }
      if (method === "GET" && path === `${base}/active`) return json({ data: {} })
      if (method === "GET" && path === session) {
        return json({ data: { id: SESSION, model: { providerID: "openai", id: "gpt-test" }, ...(sessionAgent ? { agent: sessionAgent } : {}) } })
      }
      if (method === "GET" && path === `${session}/message`) return json({ data: [], cursor: { next: null } })
      if (method === "POST" && [`${session}/agent`, `${session}/prompt`].includes(path)) return json({ data: {} })
    } else {
      const base = `/workspace/${WS}/opencode/session`
      const session = `${base}/${SESSION}`
      if (method === "POST" && path === base) return json({ id: SESSION, title: body?.title })
      if (method === "GET" && path === `${base}/status`) return json({})
      if (method === "GET" && path === session) return json({ id: SESSION, title: "Runner" })
      if (method === "GET" && path === `${session}/message`) return json([])
      if (method === "GET" && path === `${session}/todo`) return json([])
      if (method === "POST" && path === `${session}/prompt_async`) return new Response(null, { status: 204 })
    }
    return json({ message: `Unexpected ${method} ${path}` }, 500)
  }
  const adapter = createDesktopSessionAdapter({
    getLocalRuntime: async () => ({ baseUrl: BASE, token: "local-token" }),
    fetchImpl,
    operationTimeoutMs: 5_000,
  })
  const posts = (suffix) => calls.filter((call) => call.method === "POST" && call.path.endsWith(suffix))
  return { adapter, calls, posts }
}

const signal = () => new AbortController().signal

test("the runner agent is the browser-only agent the server defines", () => {
  assert.equal(UNCLEREACH_RUNNER_AGENT, "unclereach-browser")
})

test("v1: a runner session is created as, and every turn is sent as, the browser-only agent", async () => {
  const local = fakeLocal({ engine: "v1" })
  const receipt = await local.adapter.create({ commandId: "cmd_1", title: "Runner" }, signal())
  assert.equal(local.posts("/opencode/session")[0]?.body?.agent, UNCLEREACH_RUNNER_AGENT)
  await local.adapter.send(receipt, { prompt: "first", messageId: "msg_first" }, signal())
  await local.adapter.send(receipt, { prompt: "second", messageId: "msg_second" }, signal())
  const prompts = local.posts("/prompt_async").map((call) => call.body)
  assert.equal(prompts.length, 2)
  for (const prompt of prompts) assert.equal(prompt?.agent, UNCLEREACH_RUNNER_AGENT)
})

test("v2: a runner session is bound to the browser-only agent on create and re-bound before a turn", async () => {
  const local = fakeLocal({ engine: "v2", sessionAgent: "build" })
  const receipt = await local.adapter.create({ commandId: "cmd_1", title: "Runner" }, signal())
  assert.equal(local.posts("/opencode2/api/session")[0]?.body?.agent, UNCLEREACH_RUNNER_AGENT)
  await local.adapter.send(receipt, { prompt: "first", messageId: "msg_first" }, signal())
  const order = local.calls.filter((call) => call.method === "POST" && call.path.startsWith(`/workspace/${WS}/opencode2/api/session/`))
    .map((call) => call.path.split("/").pop())
  assert.deepEqual(order, ["agent", "prompt"])
  assert.deepEqual(local.posts("/agent")[0]?.body, { agent: UNCLEREACH_RUNNER_AGENT })
})

test("v2: an engine that does not bind the agent fails closed and nothing is prompted", async () => {
  const local = fakeLocal({ engine: "v2", bindsAgent: false })
  await assert.rejects(local.adapter.create({ commandId: "cmd_1", title: "Runner" }, signal()))
  assert.deepEqual(local.posts("/prompt"), [])
})
