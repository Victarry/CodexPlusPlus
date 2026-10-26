import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const source = readFileSync(path.resolve(import.meta.dirname,
  "../../../assets/inject/renderer-inject/89-archive-hosts.js"), "utf8");
const api = new Function(`${source}\nreturn {
  context: codexArchiveHostContext,
  options: codexArchiveHostOptions,
  select: selectCodexArchiveHost,
};`)();

function context(selectedHostId = "local", calls: string[] = []) {
  return {
    selectedHostId,
    connectedRemoteConnections: [{ hostId: "remote-ssh-discovered:dev", displayName: "dev" }],
    setSelectedHostId: (host: string) => calls.push(host),
  };
}

test("从当前归档页的 React Compiler 缓存读取原生主机上下文", () => {
  const expected = context();
  const anchor = { __reactFiber$test: { return: {
    updateQueue: { memoCache: { data: [[null, Symbol(), expected]] } },
  } } };
  assert.equal(api.context(anchor), expected);
});

test("兼容 useMemo 和 useRef，并优先采用当前组件的上下文", () => {
  for (const state of [[context(), []], { current: context() }]) {
    const expected = Array.isArray(state) ? state[0] : state.current;
    assert.equal(api.context({ __reactFiber$test: {
      memoizedState: { memoizedState: state },
      return: { updateQueue: { memoCache: { data: [[context("other")]] } } },
    } }), expected);
  }
});

test("缺失或不兼容的原生上下文不触发任何主机操作", () => {
  assert.equal(api.context(null), null);
  assert.equal(api.context({}), null);
  for (const invalid of [
    { ...context(), selectedHostId: null },
    { ...context(), connectedRemoteConnections: null },
    { ...context(), setSelectedHostId: null },
  ]) {
    assert.equal(api.context({ __reactFiber$test: {
      updateQueue: { memoCache: { data: [[invalid]] } },
    } }), null);
  }
});

test("损坏的祖先链有界扫描", () => {
  const fiber: any = {};
  fiber.return = fiber;
  assert.equal(api.context({ __reactFiber$test: fiber }), null);
});

test("主机选项只包含本机入口和已连接远端，忽略 durable 及无效值", () => {
  const state = context();
  state.connectedRemoteConnections.push(
    { hostId: "durable", displayName: "cloud" },
    { hostId: "", displayName: "invalid" },
    { hostId: "remote-ssh-discovered:dev", displayName: "dev" },
    { hostId: "ssh:second", displayName: "" },
  );
  assert.deepEqual(api.options(state), [
    { value: "local", label: "本机 / 云端" },
    { value: "remote-ssh-discovered:dev", label: "dev" },
    { value: "ssh:second", label: "ssh:second" },
  ]);
});

test("切换远端和返回本机调用原生 setter，重复选择不重复刷新", () => {
  const calls: string[] = [];
  const state = context("local", calls);
  assert.equal(api.select(state, "local"), true);
  assert.deepEqual(calls, []);
  assert.equal(api.select(state, "remote-ssh-discovered:dev"), true);
  assert.deepEqual(calls, ["remote-ssh-discovered:dev"]);
  state.selectedHostId = "remote-ssh-discovered:dev";
  api.select(state, "local");
  assert.deepEqual(calls, ["remote-ssh-discovered:dev", "local"]);
});

test("连接或账号变化后使用新上下文，拒绝断开的旧主机且不回退本机", () => {
  const calls: string[] = [];
  const fresh = context("local", calls);
  fresh.connectedRemoteConnections = [];
  assert.equal(api.select(fresh, "remote-ssh-discovered:dev"), false);
  assert.equal(api.select(null, "local"), false);
  assert.deepEqual(calls, []);
});

test("归档入口从后端设置读取总开关，默认开启且关闭时清理已有入口", () => {
  for (const settings of [{}, { enhancementsEnabled: true }, { enhancementsEnabled: false }]) {
    const created: any[] = [];
    const element = (tag: string) => {
      const node: any = {
        tag, dataset: {}, style: {}, children: [], removed: false,
        setAttribute() {}, addEventListener() {},
        append(...children: any[]) { this.children.push(...children); },
        replaceChildren(...children: any[]) { this.children = children; },
        querySelector(tag: string) { return this.children.find((child: any) => child.tag === tag); },
        remove() { this.removed = true; },
      };
      created.push(node);
      return node;
    };
    const container: any = {
      classList: { contains: (value: string) => value === "sticky" },
      insertBefore(node: any) { node.parentElement = this; },
    };
    const old = element("label");
    old.id = "codex-plus-archive-hosts";
    old.parentElement = container;
    old.append(element("select"));
    const anchor = {
      parentElement: { parentElement: { parentElement: container } },
      __reactFiber$test: { updateQueue: { memoCache: { data: [[context()]] } } },
    };
    const document = {
      getElementById: (id: string) => id === "archived-tasks-search" ? anchor
        : created.find(node => node.id === id && !node.removed),
      createElement: element,
    };
    // codexPlusSettings() 返回派生的单项开关，不包含 enhancementsEnabled。
    new Function("document", "codexPlusBackendSettings", "codexPlusSettings",
      `${source}\nsyncCodexArchiveHostSelector();`)(document, settings, () => ({}));
    assert.equal(old.removed, settings.enhancementsEnabled === false);
    if (!old.removed) assert.equal(old.querySelector("select").value, "local");
  }
});
