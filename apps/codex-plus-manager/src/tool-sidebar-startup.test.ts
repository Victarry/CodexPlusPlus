import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";

it("启动不请求广告，仍加载工具和设置", async () => {
  const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
  const effect = source.slice(source.indexOf("    void refreshTools(true);"));
  const startup = effect.slice(0, effect.indexOf("  }, []);"));
  const events: string[] = [];
  const noOp = async () => {};
  const dependencies = {
    refreshTools: async () => { events.push("tools"); },
    run: async (task: () => Promise<unknown>) => await task(),
    call: async () => ({ showUpdate: false }),
    consumePendingManagerNavigation: async () => false,
    setRoute: noOp,
    checkUpdate: noOp,
    refreshOverview: noOp,
    refreshSettings: async () => { events.push("settings"); },
    refreshRelay: noOp,
    refreshEnvConflicts: noOp,
    refreshProviderSyncTargets: noOp,
    refreshPendingProviderImport: noOp,
    refreshPendingDreamSkinCommunity: noOp,
  };
  // 仅去掉 TS 泛型，让实际启动 effect 在受控异步依赖中运行。
  new Function(...Object.keys(dependencies), startup.replace(/call<StartupResult>/g, "call"))(
    ...Object.values(dependencies),
  );
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(events.includes("settings"), "启动应继续加载设置");
    assert.ok(events.includes("tools"), "启动应加载工具列表");
    assert.doesNotMatch(startup, /refreshAds|load_ads/);
});
