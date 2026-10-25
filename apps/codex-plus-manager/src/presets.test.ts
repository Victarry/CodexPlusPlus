import assert from "node:assert";
import { describe, it, test } from "node:test";
import { PRESETS } from "./presets.ts";

describe("provider presets", () => {
  it("keeps MiniMax China and global credentials in separate presets", () => {
    const china = PRESETS.find((preset) => preset.id === "minimax");
    const global = PRESETS.find((preset) => preset.id === "minimax-global");

    assert.deepStrictEqual(china, {
      id: "minimax",
      name: "MiniMax (China)",
      websiteUrl: "https://platform.minimaxi.com",
      apiKeyUrl: "https://platform.minimaxi.com/subscribe/coding-plan",
      category: "cn_official",
      baseUrl: "https://api.minimaxi.com/v1",
      protocol: "chatCompletions",
      model: "MiniMax-M3",
      modelList: ["MiniMax-M3", "MiniMax-M2.7"],
    });

    assert.deepStrictEqual(global, {
      id: "minimax-global",
      name: "MiniMax (Global)",
      websiteUrl: "https://platform.minimax.io",
      apiKeyUrl: "https://platform.minimax.io/subscribe/coding-plan",
      category: "official",
      baseUrl: "https://api.minimax.io/v1",
      protocol: "chatCompletions",
      model: "MiniMax-M3",
      modelList: ["MiniMax-M3", "MiniMax-M2.7"],
    });
  });

test("DeepSeek preset uses the official Responses integration", () => {
  const preset = PRESETS.find((candidate) => candidate.id === "deepseek");
  assert.ok(preset);
  assert.equal(preset.baseUrl, "https://api.deepseek.com/");
  assert.equal(preset.protocol, "responses");
  assert.equal(preset.model, "deepseek-v4-flash");
  assert.deepEqual(preset.modelList, ["deepseek-v4-flash", "deepseek-v4-pro"]);
});


});

test("provider templates omit promoted resellers and referral parameters", () => {
  for (const id of ["jojocode", "jojocode-max", "runapi", "grooroute", "apikeyfun"]) {
    assert.equal(PRESETS.some((preset) => preset.id === id), false);
  }
  for (const preset of PRESETS) {
    for (const value of [preset.websiteUrl, preset.apiKeyUrl]) {
      if (!value) continue;
      const params = new URL(value).searchParams;
      for (const key of ["aff", "ref", "ic"]) assert.equal(params.has(key), false);
    }
  }
});
