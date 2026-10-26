#!/usr/bin/env node
// 从当前干净源码的原生构建产物打包 fork；不读取已安装应用或用户设置。
// 用法：node scripts/package-fork-release.mjs
// 只支持当前构建主机的 macOS 原生架构，明确使用 ad-hoc 签名，不声称公证。
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const text = (name) => readFileSync(path.join(root, name), "utf8");
const version = text("Cargo.toml").match(/^version = "([^"]+)"/m)?.[1];
if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) throw new Error("需要 macOS 原生构建主机");
if (!/^\d+\.\d+\.\d+$/.test(version || "")) throw new Error("需要明确的三段发行版本号");
for (const name of ["apps/codex-plus-manager/package.json", "apps/codex-plus-manager/src-tauri/tauri.conf.json"]) {
  if (JSON.parse(text(name)).version !== version) throw new Error(`版本不一致：${name}`);
}
if (run("git", ["status", "--porcelain", "--untracked-files=normal"]).trim()) throw new Error("请先提交源码，再从干净工作区打包");
const commit = run("git", ["rev-parse", "HEAD"]).trim();
const arch = process.arch === "x64" ? "x64" : "arm64";
const machoArch = process.arch === "x64" ? "x86_64" : "arm64";
const tag = `v${version}`;
const out = path.join(root, "dist", "releases", tag);
if (existsSync(out)) throw new Error(`输出已存在，保留原产物并停止：${out}`);
mkdirSync(path.dirname(out), { recursive: true });
mkdirSync(out);
const stage = path.join(out, "stage");
const iconset = path.join(out, "icon.iconset");
mkdirSync(stage);
mkdirSync(iconset);
const icon = path.join(out, "codex-plus-plus.icns");
const iconSource = path.join(root, "apps/codex-plus-manager/src-tauri/icons/icon.png");
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    run("sips", ["-z", String(size * scale), String(size * scale), iconSource, "--out", path.join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`)]);
  }
}
run("iconutil", ["-c", "icns", iconset, "-o", icon]);

const mainApp = path.join(stage, "Codex++.app");
for (const [name, binary, executable, identifier, agent] of [
  ["Codex++", "codex-plus-plus", "CodexPlusPlus", "com.bigpizzav3.codexplusplus", false],
  ["Codex++ 管理工具", "codex-plus-legacy-shim", "CodexPlusPlusManager", "com.bigpizzav3.codexplusplus.manager", true],
]) {
  const source = path.join(root, "target/release", binary);
  if (run("lipo", ["-archs", source]).trim() !== machoArch) throw new Error(`构建产物架构不符：${binary}`);
  if (Date.now() - Number(run("stat", ["-f", "%m", source]).trim()) * 1000 > 60 * 60 * 1000) throw new Error(`请先重新构建：${binary}`);
  const app = path.join(stage, `${name}.app`);
  const contents = path.join(app, "Contents");
  mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  mkdirSync(path.join(contents, "Resources"));
  copyFileSync(source, path.join(contents, "MacOS", executable));
  chmodSync(path.join(contents, "MacOS", executable), 0o755);
  copyFileSync(icon, path.join(contents, "Resources/codex-plus-plus.icns"));
  copyFileSync(path.join(root, "LICENSE"), path.join(contents, "Resources/LICENSE"));
  copyFileSync(path.join(root, "FORK.md"), path.join(contents, "Resources/FORK.md"));
  const values = {
    CFBundleName: name, CFBundleDisplayName: name, CFBundleIdentifier: identifier,
    CFBundleVersion: version, CFBundleShortVersionString: version,
    CFBundleInfoDictionaryVersion: "6.0", CFBundlePackageType: "APPL",
    CFBundleExecutable: executable, CFBundleIconFile: "codex-plus-plus.icns",
    LSMinimumSystemVersion: "12.0",
  };
  const entries = Object.entries(values).map(([key, value]) => `  <key>${key}</key><string>${value}</string>`).join("\n");
  const urls = agent ? "" : `
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>Codex++ Links</string>
    <key>CFBundleURLSchemes</key><array><string>codexplusplus</string><string>dreamskin</string></array>
  </dict></array>`;
  writeFileSync(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${entries}
  <key>CodexPlusUnifiedApp</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSUIElement</key><${agent ? "true" : "false"}/>
${urls}
</dict></plist>
`);
  writeFileSync(path.join(contents, "PkgInfo"), "APPL????");
  run("plutil", ["-lint", path.join(contents, "Info.plist")]);
  run("codesign", ["--force", "--sign", "-", app]);
  run("codesign", ["--verify", "--deep", "--strict", app]);
}
writeFileSync(path.join(stage, ".hidden"), "Codex++ 管理工具.app\n");
run("chflags", ["hidden", path.join(stage, "Codex++ 管理工具.app")]);
symlinkSync("/Applications", path.join(stage, "Applications"));
const stem = `CodexPlusPlus-${version}-macos-${arch}`;
const dmg = path.join(out, `${stem}.dmg`), zip = path.join(out, `${stem}.zip`);
run("hdiutil", ["create", "-volname", "Codex++", "-srcfolder", stage, "-format", "UDZO", dmg]);
run("hdiutil", ["verify", dmg]);
run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", mainApp, zip]);
const info = {
  version, tag, commit, repository: "Victarry/CodexPlusPlus", platform: "macos", arch,
  signing: "ad-hoc", notarized: false, builtAt: new Date().toISOString(),
  binaries: ["codex-plus-plus", "codex-plus-legacy-shim"].map(name => ({
    name, sha256: createHash("sha256").update(readFileSync(path.join(root, "target/release", name))).digest("hex"),
  })),
};
writeFileSync(path.join(out, "BUILD-INFO.json"), `${JSON.stringify(info, null, 2)}\n`);
const assets = [path.basename(dmg), path.basename(zip), "BUILD-INFO.json"];
const checksums = assets.map(name => `${createHash("sha256").update(readFileSync(path.join(out, name))).digest("hex")}  ${name}`).join("\n");
writeFileSync(path.join(out, "SHA256SUMS.txt"), `${checksums}\n`);
const base = `https://github.com/Victarry/CodexPlusPlus/releases`;
writeFileSync(path.join(out, "latest.json"), `${JSON.stringify({
  version: tag, url: `${base}/tag/${tag}`, body: text(`docs/release/${tag}-notes.md`),
  assets: [...assets, "SHA256SUMS.txt"].map(name => ({ name, url: `${base}/download/${tag}/${encodeURIComponent(name)}` })),
}, null, 2)}\n`);
console.log(JSON.stringify({ output: out, commit, version, arch, assets: [...assets, "SHA256SUMS.txt", "latest.json"] }, null, 2));
