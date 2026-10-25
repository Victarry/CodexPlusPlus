# Codex++ 无广告 fork

源码仓库：https://github.com/Victarry/CodexPlusPlus

本分支基于 [BigPizzaV3/CodexPlusPlus v1.11.2](https://github.com/BigPizzaV3/CodexPlusPlus/tree/v1.11.2)。上游原 main 保留在 `upstream-main`，无广告构建使用 `main`。保留原作者署名、AGPL-3.0-only 许可证和第三方许可证；历史提交、变更日志与审计资料保留原貌。

## 本分支改动

- 删除管理器概览横幅、推荐页、导航入口和启动广告加载。
- 删除 Codex 注入页的推荐入口、卡片、广告请求及备用源，清理旧版推荐导航节点。
- 删除 Rust 广告模块、Tauri 广告命令和桥接广告路由，不请求远端广告清单。
- 删除默认主题的内置推广内容、付费推荐服务商模板与邀请码；保留现有用户 provider、会话以及自定义主题元数据能力。
- 删除 README、网站和预览中的赞助区，移除广告图片与快照；重新生成管理器预览。
- 更新检查与下载入口指向本 fork，防止覆盖回上游原版。发布本 fork 的安装包之前，更新检查可能提示找不到 Release；没有在本次操作中创建 Release。
- 保留本机已经验证的 macOS 用户数据目录隔离修复及僵尸 worker 识别修复。

应用版本仍为 1.11.2；「关于」显示无广告 fork，诊断构建标识为 `victarry-adfree-v1.11.2-20261025`。应用标识与配置路径保持原值，以延续现有配置。

## 构建与验证

需要 Node.js 24、Rust 稳定工具链及 macOS 构建环境。首次在干净 checkout 中构建时安装锁定的前端依赖：

```sh
npm --prefix apps/codex-plus-manager ci --ignore-scripts
npm --prefix apps/codex-plus-manager run check
npm --prefix apps/codex-plus-manager test
node scripts/assemble-renderer-inject.mjs --check
cargo test --locked --release -p codex-plus-core --lib macos_
cargo test --locked --release -p codex-plus-core --test bridge_routes --test cdp_bridge --test dream_skin
npm --prefix apps/codex-plus-manager run vite:build
cargo build --locked --release -p codex-plus-manager
```

本地实测沿用 `AGENTS.md` 中固定的 `dist/local-build/Codex++.app`，在其隔离状态目录中启动。正式替换本机安装前备份完整 `.app`，保留原 `Info.plist`、资源、配置、认证和双 profile 目录关系，只替换 `Contents/MacOS/CodexPlusPlus` 并重新签名。用户无需卸载或删除原配置。

本机重签使用 ad-hoc 签名，不具备上游发行包的 Developer ID 公证身份。不要以本地测试结果替代未来发布时的签名与安装验证。
