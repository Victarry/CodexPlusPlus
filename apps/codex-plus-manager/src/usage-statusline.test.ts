// 输入框下方用量状态栏：口径与取数的行为回归。
//
// cdp_bridge.rs 只守「接线还在不在」，这里把分片里的纯计算函数抠出来放进沙箱真跑，
// 验证三件在真机上不好复现的事：
//   1. 生成速度按「同一轮内相邻事件差」算，按真实 turn_id 换轮，
//      过短/过长的间隔不能当样本；
//   2. 缓存命中与上下文占用是 Codex 自己的口径（cached/input、total/context_window），
//      窗口缺失时不能瞎算成 0%；
//   3. 会话 id 只认 composer 上的实时标识，新会话草稿（client-new-thread）没有 rollout，
//      必须当作无会话而不是拿草稿 id 去查。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const fragmentDir = path.resolve(import.meta.dirname, "../../../assets/inject/renderer-inject");
const shardSource = readFileSync(path.join(fragmentDir, "83-usage-statusline.js"), "utf8");
const shard = ts.createSourceFile("83-usage-statusline.js", shardSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const sessionRefSource = readFileSync(path.join(fragmentDir, "60-plugin-marketplace.js"), "utf8");
const sessionRefHelpers = sessionRefSource.slice(sessionRefSource.indexOf("  function isClientNewThreadId(value)"), sessionRefSource.indexOf("  if (window.__CODEX_PLUS_TEST_SESSION_REF__)"));

/** 按名字取分片里的顶层声明源码；找不到就直接失败，避免锚点漂移后静默跳过。 */
function declaration(name: string): string {
  for (const statement of shard.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement.getText(shard);
    if (ts.isVariableStatement(statement)) {
      const hit = statement.declarationList.declarations.some(
        (item) => ts.isIdentifier(item.name) && item.name.text === name,
      );
      if (hit) return statement.getText(shard);
    }
  }
  assert.fail(`分片里找不到 ${name}`);
}

const sandboxSource = [
  declaration("codexPlusUsageStaleMs"),
  declaration("codexPlusUsagePercent"),
  declaration("codexPlusUsageLatestTurn"),
  declaration("codexPlusUsageRate"),
  declaration("codexPlusUsageTurnCache"),
  declaration("codexPlusUsageSnapshot"),
  declaration("codexPlusUsageThreadId"),
  "return { codexPlusUsagePercent, codexPlusUsageRate, codexPlusUsageTurnCache, codexPlusUsageSnapshot, codexPlusUsageThreadId };",
].join("\n");

type Sandbox = {
  codexPlusUsagePercent: (numerator: number, denominator: number) => number | null;
  codexPlusUsageRate: (events: Array<Record<string, unknown>>) => number | null;
  codexPlusUsageTurnCache: (events: Array<Record<string, unknown>>) => number | null;
  codexPlusUsageSnapshot: (events: Array<Record<string, unknown>>, activity?: any) => {
    speed: number | null;
    cache: number | null;
    context: number | null;
    stale: boolean;
    modelContextWindow: number;
    activity: any;
  } | null;
  codexPlusUsageThreadId: (card: unknown) => string;
};

function sandbox(nowMs: number, documentStub: unknown = { querySelector: () => null }): Sandbox {
  // 分片用 Date.now() 判新鲜度，注入一个只改 now 的子类，Date.parse 仍走原生实现。
  class FixedDate extends Date {
    static now() {
      return nowMs;
    }
  }
  const factory = new Function("document", "navigator", "Date", sandboxSource);
  return factory(documentStub, { language: "zh-CN" }, FixedDate) as Sandbox;
}

function event(secondsFromStart: number, turnOutputTokens: number, extra: Record<string, unknown> = {}) {
  return {
    t: new Date(Date.UTC(2026, 5, 2, 5, 0, secondsFromStart)).toISOString(),
    turn_output_tokens: turnOutputTokens,
    turn_id: "turn-1",
    input_tokens: 1000,
    cached_input_tokens: 0,
    output_tokens: 0,
    total_tokens: 1000,
    context_window: 100000,
    ...extra,
  };
}

test("生成速度按同一轮内相邻事件差计算，换轮时切段", () => {
  const { codexPlusUsageRate } = sandbox(Date.UTC(2026, 5, 2, 5, 1, 0));
  const events = [
    event(0, 100),
    event(10, 600),
    event(20, 1100),
    // 累计输出跨轮仍然递增，只有 turn_id 能确认边界。
    event(30, 2100, { turn_id: "turn-2" }),
    event(40, 2600, { turn_id: "turn-2" }),
  ];
  assert.equal(codexPlusUsageRate(events), 500 / 10);
  assert.equal(codexPlusUsageRate([event(0, 100)]), null, "只有一条事件时算不出速度");
});

test("过短与过长的间隔都不作为速度样本", () => {
  const { codexPlusUsageRate } = sandbox(Date.UTC(2026, 5, 2, 5, 1, 0));
  // 0.2 秒是同一批写入，200 秒说明中间停了很久。
  assert.equal(codexPlusUsageRate([
    { ...event(0, 0), t: "2026-06-02T05:00:00.000Z" },
    { ...event(0, 500), t: "2026-06-02T05:00:00.200Z" },
  ]), null);
  assert.equal(codexPlusUsageRate([
    { ...event(0, 0), t: "2026-06-02T05:00:00.000Z" },
    { ...event(0, 50000), t: "2026-06-02T05:03:20.000Z" },
  ]), null);
});

test("缓存命中与上下文占用按 Codex 的口径取值", () => {
  const now = Date.UTC(2026, 5, 2, 5, 0, 10);
  const { codexPlusUsageSnapshot } = sandbox(now);
  const snapshot = codexPlusUsageSnapshot([
    event(0, 500, { input_tokens: 200000, cached_input_tokens: 199000, total_tokens: 250000, context_window: 1000000 }),
  ]);
  assert.ok(snapshot);
  assert.equal(Number(snapshot.cache?.toFixed(1)), 99.5);
  assert.equal(snapshot.context, 25);
  assert.equal(snapshot.modelContextWindow, 1000000);
  assert.equal(snapshot.stale, false, "刚写入的事件不算过期");

  // 窗口缺失时上下文占用必须是 null，不能算成 0% 骗人。
  const noWindow = codexPlusUsageSnapshot([event(0, 1, { context_window: 0 })]);
  assert.equal(noWindow?.context, null);

  assert.equal(codexPlusUsageSnapshot([]), null);
});

test("同一轮缓存命中率按输入 token 加权，换轮后重新计算", () => {
  const { codexPlusUsageTurnCache } = sandbox(Date.UTC(2026, 5, 2, 5, 0, 10));
  assert.equal(codexPlusUsageTurnCache([
    event(0, 100, { input_tokens: 100, cached_input_tokens: 40 }),
    event(1, 200, { input_tokens: 900, cached_input_tokens: 810 }),
  ]), 85);
  assert.equal(codexPlusUsageTurnCache([
    event(0, 100, { input_tokens: 100, cached_input_tokens: 40 }),
    event(1, 200, { input_tokens: 1000, cached_input_tokens: 100, turn_id: "turn-2" }),
  ]), 10);
});

test("会话累计输出持续增长时，第二轮 0% 不能混成 50%", () => {
  const { codexPlusUsageTurnCache, codexPlusUsageRate } = sandbox(Date.UTC(2026, 5, 2, 5, 0, 10));
  const events = [
    event(0, 100, { cached_input_tokens: 1000 }),
    event(1, 200, { turn_id: "turn-2" }),
  ];
  assert.equal(codexPlusUsageTurnCache(events), 0);
  assert.equal(codexPlusUsageRate(events), null, "新一轮只有一次调用，不能跨轮估算速度");
});

test("缺少真实轮边界的旧记录只取最后一次调用", () => {
  const { codexPlusUsageTurnCache, codexPlusUsageRate } = sandbox(Date.UTC(2026, 5, 2, 5, 0, 10));
  const events = [
    event(0, 100, { cached_input_tokens: 1000, turn_id: undefined }),
    event(1, 200, { turn_id: undefined }),
  ];
  assert.equal(codexPlusUsageTurnCache(events), 0);
  assert.equal(codexPlusUsageRate(events), null);
  assert.equal(codexPlusUsageTurnCache([]), null);
  assert.equal(codexPlusUsageTurnCache([
    event(0, 100, { input_tokens: 0, cached_input_tokens: 100, turn_id: undefined }),
  ]), null);
});

test("最近一条事件超过阈值后标记为过期", () => {
  const observed = Date.UTC(2026, 5, 2, 5, 0, 0);
  const fresh = sandbox(observed + 60_000).codexPlusUsageSnapshot([event(0, 1)]);
  const stale = sandbox(observed + 130_000).codexPlusUsageSnapshot([event(0, 1)]);
  assert.equal(fresh?.stale, false);
  assert.equal(stale?.stale, true);
});

test("三项目作为一组居中，过期只淡化速度项", () => {
  // 布局对齐 DSH 那条：三项居中成组，不是两端对齐。
  // 两端对齐会把「上下文占用」甩到最右边，和速度、缓存拉成两段信息。
  assert.match(shardSource, /justify-content:center/);
  assert.doesNotMatch(shardSource, /data-usage="context"\]\{margin-left:auto\}/);

  // 本轮结束后速度是历史读数，但缓存命中与上下文占用仍是当前值，不能一起变灰。
  const staleRule = shardSource.match(/\[data-stale="true"\][^{]*\{opacity:([^}]*)\}/g) || [];
  assert.equal(staleRule.length, 1, "只应有一条过期样式");
  assert.match(staleRule[0], /data-usage="speed"/);
  // 容器自身不能再挂 opacity：会叠在文字颜色的透明度上，实测掉到 0.36 看不清。
  assert.doesNotMatch(shardSource, /\[data-stale="true"\]\{/);
});

test("会话 id 只认 composer 上的实时标识，新会话草稿视为无会话", () => {
  const card = (composerId: string | null, placement = "thread") => ({
    closest: () => ({
      getAttribute: () => placement,
      querySelector: () => (composerId === null ? null : { getAttribute: () => composerId }),
    }),
  });
  const sidebar = (sidebarId: string | null) => ({
    querySelector: (selector: string) => {
      assert.match(selector, /data-app-action-sidebar-thread-selected/);
      return sidebarId === null ? null : { getAttribute: () => sidebarId };
    },
  });

  const { codexPlusUsageThreadId } = sandbox(Date.now(), sidebar(null));
  assert.equal(
    codexPlusUsageThreadId(card("local:01a1352f-f8a9-71f2-9ae4-f2de48a74d8d")),
    "",
    "local: 种类前缀还需要物理主机证据",
  );
  assert.equal(
    codexPlusUsageThreadId(card("01a1352f-f8a9-71f2-9ae4-f2de48a74d8d")),
    "",
    "没有主机证据时拒绝把裸 UUID 当成本机",
  );
  // thread 里 composer 没带标识时回落侧边栏选中行。
  assert.equal(
    sandbox(Date.now(), sidebar("local:01a133b6-fec1-7641-a1d1-f27100cee5b6"))
      .codexPlusUsageThreadId(card(null)),
    "",
  );
  // 首页 composer 是 placement=home，侧边栏这时仍选中着上一个 thread，
  // 兜底会把上一个会话的读数挂到新会话上，必须拒绝。
  assert.equal(
    sandbox(Date.now(), sidebar("local:01a133b6-fec1-7641-a1d1-f27100cee5b6"))
      .codexPlusUsageThreadId(card(null, "home")),
    "",
  );
  assert.equal(codexPlusUsageThreadId(card("local:client-new-thread:dac7b41a-c092-4147-827e-9010f1ba7600")), "", "新会话草稿没有 rollout");
  assert.equal(codexPlusUsageThreadId(card("__proto__")), "");
  assert.equal(codexPlusUsageThreadId(card("short")), "");
  assert.equal(codexPlusUsageThreadId(undefined), "");
});

function lifecycle(identity?: () => string) {
  const node = { isConnected: true, previousElementSibling: null as unknown, dataset: {} as Record<string, string> };
  let current = { id: "thread-a-123", card: {} };
  const renders: any[] = [];
  let resolveRequest: (value: unknown) => void = () => {};
  let rejectRequest: (error: Error) => void = () => {};
  let requestedId = "";
  let requestedHost = "local";
  const requests: Array<{ session_id: string; host_id: string }> = [];
  const source = [
    ...["codexPlusUsageState", "codexPlusUsageStaleMs", "codexPlusUsageIdleIntervalMs",
      "codexPlusUsageActiveIntervalMs", "codexPlusUsageWarmupIntervalMs", "codexPlusUsageFailureLimit",
      "codexPlusUsagePercent", "codexPlusUsageLatestTurn", "codexPlusUsageRate", "codexPlusUsageTurnCache", "codexPlusUsageSnapshot",
      "codexPlusUsageHide", "codexPlusUsageShow", "codexPlusUsageSyncPlacement",
      "codexPlusUsageRemember", "codexPlusUsageRefresh", "codexPlusUsageTick"].map(declaration),
    "return { state: codexPlusUsageState, sync: codexPlusUsageSyncPlacement, tick: codexPlusUsageTick, remember: codexPlusUsageRemember };",
  ].join("\n");
  const runtime = new Function("document", "codexPlusUsageEnabled", "codexPlusUsageComposerCard",
    "codexPlusUsageThreadId", "codexPlusUsageEnsureNode", "codexPlusUsageRender",
    "codexPlusUsageSchedule", "postJson", "sendCodexPlusDiagnostic", source)(
    { hidden: false }, () => true, () => current.card, () => identity ? identity() : current.id,
    (card: unknown) => { node.previousElementSibling = card; return node; },
    (value: unknown) => renders.push(value), () => {},
    (_path: string, payload: { session_id: string; host_id: string }) => {
      requests.push(payload);
      requestedId = payload.session_id;
      requestedHost = payload.host_id;
      return new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
    }, () => {},
  );
  runtime.state.node = node;
  return {
    ...runtime, node, renders, requests,
    switchTo(id: string) { current = { id, card: {} }; },
    respond(events: unknown[], activity: unknown = null) { resolveRequest({ status: "ok", session_id: requestedId, host_id: requestedHost, events, activity }); },
    respondFor(sessionId: string, events: unknown[], activity: unknown) { resolveRequest({ status: "ok", session_id: sessionId, host_id: requestedHost, events, activity }); },
    respondHost(hostId: string, events: unknown[], activity: unknown) { resolveRequest({status:"ok",session_id:requestedId,host_id:hostId,events,activity}); },
    fail() { rejectRequest(new Error("bridge unavailable")); },
  };
}

test("数据请求完成前就显示栏位，切换会话立即恢复各自缓存", async () => {
  const ui = lifecycle();
  const pending = ui.tick();
  assert.notEqual(ui.node.dataset.hidden, "true");
  assert.equal(ui.renders.at(-1), null);
  ui.respond([event(0, 100, { total_tokens: 27000 })]);
  await pending;
  assert.equal(ui.renders.at(-1).context, 27);
  const original = ui.state.node;
  ui.switchTo("thread-b-123");
  ui.sync();
  assert.equal(ui.renders.at(-1), null, "不能沿用其他会话的数字");
  ui.switchTo("thread-a-123");
  ui.sync();
  assert.equal(ui.renders.at(-1).context, 27);
  assert.equal(ui.state.node, original, "会话切换复用同一栏位");
});

test("旧请求返回不能覆盖当前会话，也不能在新建或设置页面重新显示", async () => {
  const ui = lifecycle();
  const pending = ui.tick();
  ui.switchTo("thread-b-123");
  ui.sync();
  ui.respond([event(0, 100, { total_tokens: 27000 })]);
  await pending;
  assert.equal(ui.renders.at(-1), null);
  assert.equal(ui.state.threadId, "thread-b-123");
  const other = ui.tick();
  ui.switchTo("");
  ui.sync();
  ui.respond([event(0, 100)]);
  await other;
  assert.equal(ui.node.dataset.hidden, "true");
  assert.equal(ui.state.threadId, "");
});

test("空数据及连续失败仍保留已有会话栏位，缓存有界", async () => {
  const ui = lifecycle();
  const pending = ui.tick();
  ui.respond([]);
  await pending;
  assert.notEqual(ui.node.dataset.hidden, "true");
  for (let i = 0; i < 5; i++) {
    const failed = ui.tick();
    ui.fail();
    await failed;
  }
  assert.equal(ui.state.failures, 5);
  assert.notEqual(ui.node.dataset.hidden, "true", "桥接不可用仍保留栏位");
  for (let i = 0; i < 40; i++) ui.remember(`thread-${i}`, [event(0, i)]);
  assert.equal(ui.state.cache.size, 32);
  assert.equal(ui.state.cache.has("thread-0"), false);
});

const activity = (turns = 6, turnCalls = 12, totalCalls = 183, turnTools = 26, totalTools = 420) => ({
  scan_complete: true, calls_complete: true, turns, turn_calls: turnCalls, total_calls: totalCalls,
  turn_tool_calls: turnTools, total_tool_calls: totalTools, tool_calls_complete: true,
});

test("累计调用使用宿主扫描结果，不能用尾部事件条数代替；首个调用前仍显示新轮次", () => {
  const { codexPlusUsageSnapshot } = sandbox(Date.now());
  const snapshot = codexPlusUsageSnapshot([event(0, 1), event(1, 2)], activity());
  assert.equal(snapshot?.activity.total_calls, 183);
  assert.equal(codexPlusUsageSnapshot([event(0, 1)])?.activity, null, "旧 helper 不提供计数时不能瞎猜");
  const started = codexPlusUsageSnapshot([], activity(7, 0, 183));
  assert.equal(started?.activity.turn_calls, 0);
  assert.equal(started?.activity.turns, 7);
  assert.equal(started?.speed, null);
  assert.equal(started?.context, null);
  assert.equal(codexPlusUsageSnapshot([], { ...activity(), total_calls: -1 }), null);
});

test("会话切换恢复各自的累计值，返回其他会话的数据不能覆盖当前计数", async () => {
  const ui = lifecycle();
  const a = ui.tick();
  ui.respond([event(0, 1)], activity(20, 30, 4000));
  await a;
  ui.switchTo("thread-b-123"); ui.sync();
  assert.equal(ui.renders.at(-1), null);
  const b = ui.tick();
  ui.respond([], activity(2, 0, 3));
  await b;
  assert.equal(ui.renders.at(-1).activity.total_calls, 3);
  ui.switchTo("thread-a-123"); ui.sync();
  assert.equal(ui.renders.at(-1).activity.total_calls, 4000);
  ui.switchTo("thread-c-123"); ui.sync();
  const c = ui.tick();
  ui.respondFor("thread-b-123", [], activity(999, 999, 999));
  await c;
  assert.equal(ui.renders.at(-1), null);
  assert.equal(ui.state.cache.has("thread-c-123"), false);
});

function renderHarness(language = "zh-CN") {
  const attrs = new Map<string, string>();
  const parts = Object.fromEntries(["speed", "cache", "context", "activity", "tools", "tokens"].map(key => [key, {
    value: { textContent: "" }, item: { title: "" },
  }]));
  const state = { node: { isConnected: true, dataset: {}, setAttribute: (key: string, value: string) => attrs.set(key, value) }, parts, lastFingerprint: "", threadId: "thread-a-123", failures: 0 };
  const diagnostics: any[] = [];
  const render = new Function("document", "navigator", "codexPlusUsageState", "sendCodexPlusDiagnostic", [
    declaration("codexPlusUsageRingCircumference"), declaration("codexPlusUsageText"),
    declaration("codexPlusUsageRender"), "return codexPlusUsageRender;",
  ].join("\n"))({ documentElement: { lang: language } }, { language }, state, (event: string, detail: unknown) => diagnostics.push({ event, detail }));
  return { render, parts, attrs, diagnostics, state };
}

test("状态栏显示三项计数，计数变化会刷新 DOM，扫描中和不完整记录有明确标识", () => {
  const ui = renderHarness();
  ui.render({ activity: activity() });
  assert.equal(ui.parts.activity.value.textContent, "会话 6 轮 · 模型 本轮 12 / 累计 183");
  assert.match(ui.parts.activity.item.title, /不含工具执行、失败或网络重试/);
  ui.render({ activity: activity(6, 13, 184) });
  assert.equal(ui.parts.activity.value.textContent, "会话 6 轮 · 模型 本轮 13 / 累计 184");
  ui.render({ activity: { ...activity(), scan_complete: false } });
  assert.equal(ui.parts.activity.value.textContent, "会话统计中…");
  ui.render({ activity: { ...activity(), turns: null, turn_calls: null, calls_complete: false } });
  assert.equal(ui.parts.activity.value.textContent, "会话 — 轮 · 模型 本轮 — / 累计 ≥183");
  assert.match(ui.attrs.get("aria-label") || "", /累计 ≥183/);
  ui.render(null);
  assert.doesNotMatch(ui.parts.activity.value.textContent, /183/, "空会话不能保留上一个会话的计数");
  assert.match(shardSource, /flex-wrap:wrap/);
});

test("英文状态栏明确标注模型调用计数", () => {
  const ui = renderHarness("en-US");
  ui.render({ activity: activity() });
  assert.equal(ui.parts.activity.value.textContent, "6 turns · Model calls 12 / 183");
  assert.match(ui.parts.activity.item.title, /completed model calls/);
});

test("远端主机和会话 ID 组成独立缓存键", () => {
  const id = "01a1352f-f8a9-71f2-9ae4-f2de48a74d8d";
  const card = { closest: () => ({ getAttribute: () => "thread", querySelector: () => ({ getAttribute: () => id }) }) };
  const document = { querySelector: () => ({ getAttribute: () => id }) };
  const threadId = new Function("document", "sessionRefFromRow", `${declaration("codexPlusUsageThreadId")}\nreturn codexPlusUsageThreadId;`)(
    document, () => ({ session_id: id, host_id: "remote-ssh-discovered:dev-kth" }),
  );
  assert.equal(threadId(card), "remote-ssh-discovered:dev-kth\x1f" + id);
});

function nativeIdentityFixture(options: { host?: string; selected?: boolean; nested?: boolean; draft?: boolean; composerHost?: string; sidebarHost?: string; sidebarId?: string } = {}) {
  const { host = "remote-ssh-discovered:dev", selected = true, nested = false, draft = false, composerHost = host, sidebarHost = host, sidebarId = "11111111-1111-4111-8111-111111111111" } = options;
  const id = "11111111-1111-4111-8111-111111111111";
  const element = (attributes: Record<string, string>, props: any = null): any => ({
    getAttribute: (name: string) => attributes[name] ?? null,
    querySelector: () => null,
    __reactFiber$fixture: { pendingProps: props, return: null },
  });
  // 26.1016.61520 原生合同：sidebar key 的 local: 表示会话种类，
  // SSH 的真实机器仍由 data-...-host-id / 成对 conversationId + hostId 给出。
  const row = element({ "data-app-action-sidebar-thread-id": `local:${sidebarId}`, "data-app-action-sidebar-thread-host-id": sidebarHost, "data-app-action-sidebar-thread-kind": "local" }, { conversationId: sidebarId, hostId: sidebarHost });
  const scope = element({ "data-composer-placement": draft ? "home" : "thread" }, { conversationId: id, hostId: composerHost });
  scope.querySelector = () => ({ getAttribute: () => draft ? `client-new-thread:${id}` : id });
  const inner = nested ? element({}) : scope;
  const card = { closest: (selector: string) => selector === "[data-composer-placement]" ? scope : inner };
  const resolve = new Function("document", "selectors", `${sessionRefHelpers}\n${declaration("codexPlusUsageThreadId")}\nreturn codexPlusUsageThreadId;`)(
    { querySelector: () => selected ? row : null }, { threadTitle: ".title" },
  );
  return { resolve: () => resolve(card), id };
}

test("当前客户端的 local: 种类前缀与远端物理主机不冲突", () => {
  const remote = nativeIdentityFixture();
  assert.equal(remote.resolve(), `remote-ssh-discovered:dev\x1f${remote.id}`);
  const local = nativeIdentityFixture({ host: "local" });
  assert.equal(local.resolve(), local.id);
});

test("嵌套 composer 与隐藏侧栏仍从当前会话的成对元数据识别主机", () => {
  for (const options of [{ nested: true }, { selected: false }, { nested: true, selected: false }]) {
    const fixture = nativeIdentityFixture(options);
    assert.equal(fixture.resolve(), `remote-ssh-discovered:dev\x1f${fixture.id}`);
  }
});

test("原生主机证据冲突或新会话草稿不会继承旧会话来源", () => {
  assert.equal(nativeIdentityFixture({ composerHost: "remote-ssh-discovered:other" }).resolve(), "");
  assert.equal(nativeIdentityFixture({ draft: true }).resolve(), "");
  const fixture = nativeIdentityFixture({ selected: false, composerHost: "" });
  assert.equal(fixture.resolve(), "", "裸 UUID 与 local: 种类标签都不能证明物理主机");
  const unrelated = nativeIdentityFixture({ sidebarId: "22222222-2222-4222-8222-222222222222", sidebarHost: "remote-ssh-discovered:other" });
  assert.equal(unrelated.resolve(), `remote-ssh-discovered:dev\x1f${unrelated.id}`, "不相关侧栏不能覆盖当前 composer 的成对归属");
});

function freshIdentityFixture(host = "remote-ssh-discovered:dev") {
  const id = "33333333-3333-4333-8333-333333333333";
  const alias = "client-new-thread:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let portal: string | null = alias;
  let route = "";
  const composerProps: any = { clientThreadId: alias, conversationId: null, hostId: host };
  const rowProps: any = { clientThreadId: alias, conversationId: null, hostId: host };
  const attrs: Record<string, string> = { "data-app-action-sidebar-thread-id": `local:${alias}`, "data-app-action-sidebar-thread-host-id": host, href: `/thread/${alias}` };
  const row: any = { getAttribute: (key: string) => attrs[key] ?? null, querySelector: () => null, __reactFiber$fixture: { pendingProps: rowProps, return: null } };
  const scope: any = { getAttribute: (key: string) => key === "data-composer-placement" ? "thread" : null, querySelector: () => portal === null ? null : ({ getAttribute: () => portal }), __reactFiber$fixture: { pendingProps: composerProps, return: null } };
  const card = { closest: () => scope };
  const resolve = new Function("document", "selectors", "window", `${sessionRefHelpers}\n${declaration("codexPlusUsageThreadId")}\nreturn codexPlusUsageThreadId;`)(
    { querySelector: () => row }, { threadTitle: ".title" }, { get location() { return { pathname: route }; } },
  );
  return {
    id, alias, rowProps, composerProps, attrs,
    resolve: () => resolve(card),
    setRoute(pathname: string) { route = pathname; },
    start(options: { portal?: "temporary" | "canonical" | "missing"; composer?: boolean; sidebar?: boolean } = {}) {
      portal = options.portal === "canonical" ? id : options.portal === "missing" ? null : alias;
      composerProps.conversationId = options.composer === false ? null : id;
      rowProps.conversationId = options.sidebar === false ? null : id;
    },
  };
}

test("新会话保留临时 sidebar key 时，正式 portal 仍能与真实主机配对", () => {
  const fixture = freshIdentityFixture();
  fixture.start({ portal: "canonical", composer: false });
  assert.equal(fixture.resolve(), `remote-ssh-discovered:dev\x1f${fixture.id}`);
});

test("发送后临时或空 portal 自动解析成对的 clientThreadId 与正式会话 ID", () => {
  for (const portal of ["temporary", "missing"] as const) {
    const fixture = freshIdentityFixture();
    assert.equal(fixture.resolve(), "");
    fixture.start({ portal });
    assert.equal(fixture.resolve(), `remote-ssh-discovered:dev\x1f${fixture.id}`);
  }
  const nested = freshIdentityFixture(); nested.start({ composer: false, sidebar: false });
  nested.composerProps.threadSummary = { id: nested.id };
  assert.equal(nested.resolve(), `remote-ssh-discovered:dev\x1f${nested.id}`, "正式 ID 也可来自同一条关联记录的 threadSummary");
});

test("新草稿没有正式映射时不借用旧 sidebar，矛盾映射同样拒绝", () => {
  const draft = freshIdentityFixture();
  draft.attrs["data-app-action-sidebar-thread-id"] = "local:11111111-1111-4111-8111-111111111111";
  draft.attrs.href = "/thread/11111111-1111-4111-8111-111111111111";
  draft.rowProps.conversationId = "11111111-1111-4111-8111-111111111111";
  draft.rowProps.clientThreadId = "client-new-thread:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  draft.start({ portal: "missing", composer: false, sidebar: false });
  draft.rowProps.conversationId = "11111111-1111-4111-8111-111111111111";
  assert.equal(draft.resolve(), "");
  const conflict = freshIdentityFixture(); conflict.start();
  conflict.rowProps.conversationId = "22222222-2222-4222-8222-222222222222";
  assert.equal(conflict.resolve(), "");
});

test("新会话无需重开：同一输入框从草稿到发送再到统计自动挂载", async () => {
  const fixture = freshIdentityFixture();
  const ui = lifecycle(fixture.resolve);
  await ui.tick();
  assert.equal(ui.node.dataset.hidden, "true");
  assert.equal(ui.requests.length, 0);
  fixture.start({ portal: "missing" });
  const pending = ui.tick();
  assert.equal(ui.node.dataset.hidden, "false");
  assert.deepEqual(ui.requests, [{ session_id: fixture.id, host_id: "remote-ssh-discovered:dev" }]);
  ui.respond([], { ...activity(1, 1, 1), cumulative_tokens: 23417 });
  await pending;
  assert.equal(ui.renders.at(-1).activity.cumulative_tokens, 23417);
});

test("临时 route 与同一 sidebar 的正式链接可以配对，其他 route 不可借用", () => {
  const fixture = freshIdentityFixture(); fixture.start({ portal: "missing", composer: false, sidebar: false });
  delete fixture.composerProps.clientThreadId;
  delete fixture.rowProps.clientThreadId;
  fixture.attrs.href = `/thread/${fixture.id}`;
  fixture.setRoute(`/thread/${encodeURIComponent(fixture.alias)}`);
  assert.equal(fixture.resolve(), `remote-ssh-discovered:dev\x1f${fixture.id}`);
  fixture.setRoute("/thread/client-new-thread:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  assert.equal(fixture.resolve(), "");
});

test("当前原生 sidebar 的稳定 key 与 summary 正式 ID 能建立新会话映射", () => {
  const fixture = freshIdentityFixture(); fixture.start({ portal: "missing", composer: false, sidebar: false });
  delete fixture.rowProps.clientThreadId;
  fixture.rowProps.entry = { kind: "local", key: `local:${fixture.alias}`, summary: { id: fixture.id, hostId: "remote-ssh-discovered:dev" } };
  assert.equal(fixture.resolve(), `remote-ssh-discovered:dev\x1f${fixture.id}`);
});

test("真实挂载诊断仅报告阶段变化，不写入会话 UUID 或计数", () => {
  const ui = renderHarness();
  const id = "11111111-1111-4111-8111-111111111111";
  ui.state.threadId = `remote-ssh-discovered:dev\x1f${id}`;
  ui.render(null);
  ui.render({ activity: { ...activity(), scan_complete: false } });
  ui.render({ activity: { ...activity(), cumulative_tokens: 5300000 } });
  ui.render({ activity: { ...activity(6, 13, 184), cumulative_tokens: 5400000 } });
  assert.deepEqual(ui.diagnostics.map(row => row.detail.phase), ["waiting", "scanning", "ready"]);
  assert.deepEqual(ui.diagnostics.at(-1), { event: "usage_statusline_state", detail: { version: 7, phase: "ready", source: "remote", hasTokens: true, mounted: true } });
  assert.doesNotMatch(JSON.stringify(ui.diagnostics), new RegExp(`${id}|5300000|5400000`));
});

test("模型与工具计数分别显示，工具输出或更新不影响模型读数", () => {
  const ui = renderHarness();
  ui.render({ activity: activity() });
  assert.equal(ui.parts.activity.value.textContent, "会话 6 轮 · 模型 本轮 12 / 累计 183");
  assert.equal(ui.parts.tools.value.textContent, "工具 本轮 26 / 累计 420");
  assert.match(ui.parts.tools.item.title, /call_id 去重/);
  ui.render({ activity: activity(6, 12, 183, 27, 421) });
  assert.equal(ui.parts.activity.value.textContent, "会话 6 轮 · 模型 本轮 12 / 累计 183");
  assert.equal(ui.parts.tools.value.textContent, "工具 本轮 27 / 累计 421");
  ui.render({ activity: { ...activity(), tool_calls_complete: false } });
  assert.equal(ui.parts.tools.value.textContent, "工具 本轮 ≥26 / 累计 ≥420");
  assert.match(ui.attrs.get("aria-label") || "", /工具 本轮 ≥26/);
  ui.render({ activity: { scan_complete: true, turns: 6, turn_calls: 12, total_calls: 183, calls_complete: true } });
  assert.equal(ui.parts.tools.value.textContent, "工具 本轮 — / 累计 —", "旧 helper 未提供工具计数时不能当成零");
});

test("同 UUID 的本机与两台远端会话缓存完全隔离，返回主机不匹配时拒绝数据", async () => {
  const ui = lifecycle();
  const local = ui.tick(); ui.respond([], activity(1, 1, 10)); await local;
  ui.switchTo("remote-ssh-discovered:dev\x1fthread-a-123"); ui.sync();
  assert.equal(ui.renders.at(-1), null);
  const remote = ui.tick(); ui.respond([], activity(2, 2, 20)); await remote;
  assert.equal(ui.renders.at(-1).activity.total_calls, 20);
  ui.switchTo("remote-ssh-discovered:dev-kth\x1fthread-a-123"); ui.sync();
  const kth = ui.tick(); ui.respondHost("remote-ssh-discovered:dev", [], activity(99, 99, 999)); await kth;
  assert.equal(ui.renders.at(-1), null);
  ui.switchTo("thread-a-123"); ui.sync();
  assert.equal(ui.renders.at(-1).activity.total_calls, 10);
});

test("内置累计 token 与主机来源一起显示，不借用其他会话累计值", () => {
  const ui = renderHarness();
  ui.render({activity:{...activity(), cumulative_tokens:5300000}});
  assert.equal(ui.parts.tokens.value.textContent,"会话 5.30M tok");
  ui.render({activity:activity()});
  assert.equal(ui.parts.tokens.value.textContent,"会话 — tok");
});
