import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const source = readFileSync(new URL("../../../assets/inject/renderer-inject/88-side-chat-save.js", import.meta.url), "utf8");
function api() {
  return new Function("window", `${source}\nreturn {
    snapshot:codexSideSaveSnapshot, turns:codexSideSaveTurns, rollout:codexSideSaveRollout,
    check:codexSideSaveCheckHistory, base64:codexSideSaveBase64, fingerprint:codexSideSaveFingerprint,
    persist:codexSideSavePersist, state:codexSideSaveState, scopes:codexSideSaveScopes,
    argv:codexSideSaveArgv, core:codexSideSaveCoreItem, read:codexSideSaveReadHistory, context:codexSideSaveContext,
  };`)({});
}
function conversation() {
  const first = { turnId: "first", status: "completed", params: {}, items: [
    { type: "userMessage", id: "u1", content: [{ type: "text", text: "中文🙂\n原始输入" }] },
    { type: "commandExecution", id: "cmd", command: "printf '你好'", cwd: "/tmp", aggregatedOutput: "你好\n", status: "completed", exitCode: 0, durationMs: 1222 },
    { type: "reasoning", id: "r", summary: ["保留可见摘要"], content: [] },
    { type: "agentMessage", id: "a1", text: "第一轮回复\n", phase: "final_answer" },
  ] };
  const second = { turnId: "second", status: "completed", params: { attachments: [{ path: "/tmp/中文.pdf", text: "附件正文" }] }, items: [
    { type: "userMessage", id: "u2", content: [{ type: "text", text: "继续" }] },
    { type: "mcpToolCall", id: "mcp", server: "test", tool: "read", arguments: { q: "完整参数" }, result: { content: [{ type: "text", text: "完整结果" }] } },
    { type: "newFutureItem", id: "future", nested: { value: "未知条目也保留" } },
    { type: "agentMessage", id: "a2", text: "第二轮回复", phase: "final_answer" },
  ] };
  return { id: "side", hostId: "ssh:dev", ephemeral: true, sideConversation: true,
    cwd: "/tmp", latestModel: "test-model", modelProvider: "openai", requests: [],
    turnHistory: { kind: "canonical", history: { isComplete: true,
      // 字典插入顺序不等于历史顺序。
      entitiesByKey: { second, first }, islands: [{ entries: [{ value: "first" }, { value: "second" }] }] } } };
}

test("按 canonical 顺序保存全部条目，不更改源对象或收集认证/运行时字段", () => {
  const a = api(), c: any = conversation(), before = JSON.stringify(c);
  c.auth = { secret: "must-not-save" };
  const snapshot = a.snapshot(c, "ssh:dev");
  assert.deepEqual(snapshot.turns.map((t: any) => t.turnId), ["first", "second"]);
  assert.equal(snapshot.turns[1].items[2].nested.value, "未知条目也保留");
  assert.equal(JSON.stringify(snapshot).includes("must-not-save"), false);
  delete c.auth;
  assert.equal(JSON.stringify(c), before);
});

test("拒绝跨主机、普通聊天、历史缺页、未完成条目和活动请求", () => {
  for (const change of [
    (c: any) => { c.hostId = "local"; },
    (c: any) => { c.ephemeral = false; },
    (c: any) => { c.turnHistory.history.isComplete = false; },
    (c: any) => { delete c.turnHistory.history.entitiesByKey.first; },
    (c: any) => { c.turnHistory.history.entitiesByKey.first.status = "inProgress"; },
    (c: any) => { c.turnHistory.history.entitiesByKey.first.itemsPagination = { hasLoadedOldest: false }; },
    (c: any) => { c.requests = [{}]; },
    (c: any) => { c.unconfirmedTurnSubmissions = [{ terminal: false }]; },
  ]) {
    const c = conversation(); change(c);
    assert.throws(() => api().snapshot(c, "ssh:dev"));
  }
});

test("完整保存 Unicode、原始工具 JSON、附件及未知条目，不遗留未配对调用", () => {
  const a = api(), snapshot = a.snapshot(conversation(), "ssh:dev");
  const { body, counts } = a.rollout(snapshot, "saved-id", "0.162.1", "2026-10-26T00:00:00.000Z");
  const rows = body.trim().split("\n").map(JSON.parse), calls = rows.filter((r: any) => r.payload.type === "function_call");
  const results = rows.filter((r: any) => r.payload.type === "function_call_output");
  assert.deepEqual(counts, { turns: 2, user: 2, assistant: 2, tools: 2, fallback: 1 });
  assert.equal(rows[0].payload.id, "saved-id");
  assert.equal(rows[0].payload.history_mode, "paginated");
  assert.deepEqual(rows.map((row: any) => row.ordinal), rows.map((_: any, index: number) => index));
  assert.equal(rows.find((row: any) => row.payload.item?.type === "CommandExecution").payload.item.cwd, "file:///tmp");
  assert.deepEqual(calls.map((r: any) => r.payload.call_id), results.map((r: any) => r.payload.call_id));
  assert.deepEqual(JSON.parse(results[0].payload.output), snapshot.turns[0].items[1]);
  assert.ok(body.includes("附件正文"));
  assert.ok(body.includes("未知条目也保留"));
  assert.equal(Buffer.from(a.base64(body), "base64").toString("utf8"), body);
});

test("历史过大时明确失败，不截断", () => {
  const c = conversation();
  c.turnHistory.history.entitiesByKey.first.items[0].content![0].text = "x".repeat(33 * 1024 * 1024);
  assert.throws(() => api().snapshot(c, "ssh:dev"), /32 MiB/);
});

test("历史命令只解析参数以恢复展示，保留引号、空参数、Unicode 和反斜杠", () => {
  const a = api();
  assert.deepEqual(a.argv(`/usr/bin/zsh -lc 'printf "你好\\n"'`), ["/usr/bin/zsh", "-lc", 'printf "你好\\n"']);
  assert.deepEqual(a.argv(`printf '' "a b" c\\ d`), ["printf", "", "a b", "c d"]);
  assert.deepEqual(a.argv(`broken 'quote`), ["broken 'quote"]);
});

test("原生 route.hostId 为空时按当前注册中心解析 SSH 身份；冲突不回退本机", async () => {
  const a = api(), id = "00000000-0000-4000-8000-000000000001";
  const manager = (hostId: string) => ({ getHostId: () => hostId,
    getConversation: () => ({ id, hostId, ephemeral: true, sideConversation: true }) });
  const managers = [manager("ssh:dev")], scope = { get: () => managers, value: { routeKind: "local-thread", hostId: null } };
  const panel = { isConnected: true, getAttribute: () => "sidechat:" + id,
    __reactFiber$test: { memoizedState: { memoizedState: { current: scope } } } };
  const runtime = { native: { registry: {} }, binding: { allManagers: "registry" } };
  assert.equal((await a.context(panel, runtime)).hostId, "ssh:dev");
  managers.push(manager("local"));
  await assert.rejects(a.context(panel, runtime), /冲突/);
  managers.splice(0);
  await assert.rejects(a.context(panel, runtime), /连接/);
});

function thread(snapshot: any) {
  return { path: "/home/test/.codex/sessions/saved.jsonl", ephemeral: false,
    turns: snapshot.turns.map((turn: any) => ({ id: turn.turnId, items: turn.items })) };
}
test("重新读取必须保留原正文和轮次；消息丢失、错序或临时会话不能成功", () => {
  const a = api(), snapshot = a.snapshot(conversation(), "ssh:dev");
  a.check(snapshot, thread(snapshot));
  for (const mutate of [
    (t: any) => { t.ephemeral = true; }, (t: any) => { t.path = null; },
    (t: any) => { t.turns.pop(); }, (t: any) => { t.turns.reverse(); },
    (t: any) => { t.turns[0].items = []; },
    (t: any) => { t.turns[0].items[1].aggregatedOutput = "truncated"; },
    (t: any) => { t.turns[1].items = t.turns[1].items.filter((i: any) => i.type !== "mcpToolCall"); },
  ]) {
    const t = structuredClone(thread(snapshot)); mutate(t);
    assert.throws(() => a.check(snapshot, t));
  }
});

test("分页核对读取全部轮次与条目，不能把服务端第一页当作完整历史", async () => {
  const calls: any[] = [], m = { sendRequest: async (method: string, params: any) => {
    calls.push({ method, ...params });
    if (method === "thread/turns/list") return params.cursor == null
      ? { data: [{ id: "first" }], nextCursor: "turn-page-2" }
      : { data: [{ id: "second" }], nextCursor: null };
    return params.cursor == null
      ? { data: [{ item: { id: params.turnId + "-a" } }], nextCursor: "item-page-2" }
      : { data: [{ id: params.turnId + "-b" }], nextCursor: null };
  } };
  const r = await api().read(m, { id: "saved", historyMode: "paginated" });
  assert.deepEqual(r.turns.map((t: any) => t.items.map((i: any) => i.id)), [["first-a", "first-b"], ["second-a", "second-b"]]);
  assert.equal(calls.length, 6);
});

test("兼容拓展来自同一分片，新内置版本接管时停止观察器并避免重复安装", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-side-save-")), output = path.join(dir, "bridge.js");
  execFileSync(process.execPath, [new URL("../../../scripts/build-side-chat-save-extension.mjs", import.meta.url).pathname, output]);
  const body = readFileSync(output, "utf8");
  assert.ok(body.includes(source));
  assert.equal(statSync(output).mode & 0o777, 0o600);
  let observations = 0, cleaned = 0;
  const window: any = { codexPlus: {}, __codexPlusSideChatSaveState: { builtinVersion: 2 } };
  new Function("window", "MutationObserver", body)(window, class { constructor() { observations += 1; } });
  assert.equal(observations, 0);
  window.__codexPlusSideChatSaveState = { extensionCleanup: () => { cleaned += 1; } };
  new Function("window", source)(window);
  assert.equal(cleaned, 1);
  assert.equal(window.__codexPlusSideChatSaveState.builtinVersion, 2);
});

test("布局样式由按钮行持有，重复扫描不叠加，禁用后完整移除并能重新挂载", () => {
  class Element {
    tagName: string;
    attributes = new Map<string, string>();
    children: Element[] = [];
    parent: Element | null = null;
    className = "";
    textContent = "";
    constructor(tagName: string) { this.tagName = tagName; }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
    append(...nodes: Element[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    prepend(node: Element) { node.parent = this; this.children.unshift(node); }
    querySelector() { return this.children.find(node => node.attributes.has("data-codex-plus-side-save")); }
    addEventListener() {}
    remove() {
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    }
  }
  const panel = new Element("div"), native = new Element("div");
  panel.setAttribute("data-tab-id", "sidechat:00000000-0000-4000-8000-000000000001");
  panel.className = "min-h-0 min-w-0 flex-1 outline-none relative";
  native.className = "flex h-full min-h-0 min-w-0 flex-col";
  panel.append(native);
  const original = [panel.className, native.className, [...panel.attributes], [...native.attributes]];
  const document = {
    createElement: (tag: string) => new Element(tag),
    querySelectorAll: (selector: string) => selector.startsWith('[role="tabpanel"]')
      ? [panel] : panel.children.filter(node => node.attributes.has("data-codex-plus-side-save")),
  };
  const settings = { enhancementsEnabled: true };
  const scan = new Function("window", "document", "codexPlusBackendSettings",
    `${source}\nreturn syncCodexSideChatSaveButtons;`)({}, document, settings);
  scan(); scan();
  assert.equal(panel.children.length, 2);
  const row = panel.children[0];
  assert.deepEqual(row.children.map(node => node.tagName), ["style", "button"]);
  assert.equal(row.children[1].textContent, "保存为正式聊天");
  assert.equal(panel.children[1], native);
  assert.match(row.children[0].textContent, /:has\(> \[data-codex-plus-side-save\]\)/);
  settings.enhancementsEnabled = false;
  scan();
  assert.deepEqual(panel.children, [native]);
  assert.equal(row.parent, null, "入口移除时其拥有的布局样式也必须离开文档");
  assert.deepEqual([panel.className, native.className, [...panel.attributes], [...native.attributes]], original);
  settings.enhancementsEnabled = true;
  scan();
  assert.equal(panel.children.length, 2);
  assert.notEqual(panel.children[0], row);
});

test("保存使用原主机文件系统，写后核对、私有权限、重复保存和失败重试复用同一目标", async () => {
  const a = api(), snapshot = a.snapshot(conversation(), "ssh:dev"), writes: any[] = [], files = new Map();
  let failResume = true, cached: any;
  const manager = {
    getCodexHome: async () => "/home/test/.codex", requestClient: { getAppServerVersion: () => "0.162.1" },
    sendRequest: async (method: string, params: any) => {
      writes.push({ method, params });
      if (method === "fs/writeFile") files.set(params.path, params.dataBase64);
      if (method === "fs/readFile") return { dataBase64: files.get(params.path) };
      if (method === "command/exec") return { exitCode: 0 };
      if (method === "thread/resume") { if (failResume) throw Error("connection interrupted"); return { thread: thread(snapshot) }; }
      if (method === "thread/read") return { thread: thread(snapshot) };
      return {};
    },
    resumeConversation: async () => { cached = { ephemeral: false }; return { status: "ready" }; },
    getConversation: () => cached, getThreadProjectAssignment: async () => undefined,
  };
  const ctx = { manager, scope: { value: { conversationId: "parent" } }, hostId: "ssh:dev",
    native: { inputs: () => () => ({}), host: () => {} }, binding: { resumeInputs: "inputs", registerHost: "host" } };
  await assert.rejects(a.persist(ctx, snapshot), /connection interrupted/);
  const firstFiles = writes.filter((r) => r.method === "fs/writeFile");
  assert.equal(firstFiles.length, 2);
  assert.ok(firstFiles[0].params.path.startsWith("/home/test/.codex/side-chat-saves/"));
  assert.ok(firstFiles[1].params.path.startsWith("/home/test/.codex/sessions/"));
  failResume = false;
  const saved = await a.persist(ctx, snapshot), repeat = await a.persist(ctx, snapshot);
  assert.equal(repeat.id, saved.id);
  assert.equal(writes.filter((r) => r.method === "fs/writeFile").length, 2, "重试不能覆写已恢复的历史或创建重复会话");
  assert.ok(writes.some((r) => r.method === "command/exec" && r.params.command[1] === "700"));
  assert.equal(writes.filter((r) => r.method === "command/exec" && r.params.command[1] === "600").length, 2);
  for (const request of writes.filter((r) => r.method === "command/exec")) {
    assert.equal(request.params.sandboxPolicy.type, "workspaceWrite");
    assert.equal(request.params.sandboxPolicy.networkAccess, false);
    assert.equal(request.params.sandboxPolicy.writableRoots.length, 1);
    assert.ok(request.params.sandboxPolicy.writableRoots[0].startsWith("/home/test/.codex/"));
    assert.notEqual(request.params.sandboxPolicy.writableRoots[0], "/home/test/.codex");
  }
  assert.equal(writes.filter((r) => r.method === "thread/read").length, 1);
  assert.equal(a.state.pending.size, 0);
});
