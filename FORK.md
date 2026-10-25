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

应用版本仍为 1.11.2；「关于」显示无广告 fork，诊断构建标识为 `victarry-model-tools-v1.11.2-20261025`。应用标识与配置路径保持原值，以延续现有配置。

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

## 会话轮次与模型调用计数

用量状态栏增加 `会话 6 轮 · 本轮 12 次 · 累计 183 次`：轮数按当前本地 rollout 中的 `turn_id` 去重，次数为有真实输入 / 输出用量的已完成模型调用。工具执行、重复 token_count、限额刷新、上下文估算与 context-full 哨兵不会新增调用。失败或未写出用量的网络重试不在此计数中，不能把它当作网关账单的 HTTP 请求总数。

首次按最多 8 MiB / 次扫描历史，预热时显示“会话统计中…”，之后只消费新增字节；按文件路径隔离、有界缓存，并在文件截断、替换或检测到改写后重建。半行保留到续写完整，超大工具输出不保存在缓存。缺少可靠轮次显示 `—`，无法确认完整性的用量显示 `≥` 下界。自动续跑也可能产生新的 Codex 任务轮次，轮数不是用户消息条数。

数据接入现有内置 `/thread-usage-live`，没有扩大第三方扩展路由白名单。当前只读取该实例自己的本机会话记录；SSH 远端没有对应本地 rollout 时显示不可用，不跨 profile 查询或借用其他会话的计数。

相关验证：

```sh
cargo test --locked --release -p codex-plus-data --lib usage_activity
cargo test --locked --release -p codex-plus-data --test storage_adapter
node --test apps/codex-plus-manager/src/usage-statusline.test.ts
```

## 分开显示模型与工具调用

状态栏分别显示 `模型 本轮 12 / 累计 183` 与 `工具 本轮 26 / 累计 420`。模型数仍来自去重后的真实输入 / 输出用量；工具数来自模型可见的外层 `function_call` / `custom_tool_call` 等工具请求，按 `call_id` 去重，内置搜索 / 生图等服务端工具按条目 ID 去重。

工具输出、`item_completed` 界面镜像、重复通知和批量执行内部子步骤不额外累加；失败或取消的外层工具请求仍计为一次工具请求。工具数与模型数完全独立，一个模型响应可以发出多个工具请求。旧 helper 缺少工具字段时显示 `—`，缺 ID 或条目过大无法完整统计时显示 `≥` 下界。
