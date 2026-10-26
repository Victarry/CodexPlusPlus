# Codex++ 无广告 fork

源码仓库：https://github.com/Victarry/CodexPlusPlus

本分支基于 [BigPizzaV3/CodexPlusPlus v1.11.2](https://github.com/BigPizzaV3/CodexPlusPlus/tree/v1.11.2)。上游原 main 保留在 `upstream-main`，无广告构建使用 `main`。保留原作者署名、AGPL-3.0-only 许可证和第三方许可证；历史提交、变更日志与审计资料保留原貌。

## 本分支改动

- 删除管理器概览横幅、推荐页、导航入口和启动广告加载。
- 删除 Codex 注入页的推荐入口、卡片、广告请求及备用源，清理旧版推荐导航节点。
- 删除 Rust 广告模块、Tauri 广告命令和桥接广告路由，不请求远端广告清单。
- 删除默认主题的内置推广内容、付费推荐服务商模板与邀请码；保留现有用户 provider、会话以及自定义主题元数据能力。
- 删除 README、网站和预览中的赞助区，移除广告图片与快照；重新生成管理器预览。
- 更新检查与下载入口指向本 fork，防止覆盖回上游原版。本 fork 使用独立版本号，首个发行版为 v1.11.3。
- 保留本机已经验证的 macOS 用户数据目录隔离修复及僵尸 worker 识别修复。

当前 fork 版本为 1.11.3；「关于」显示无广告 fork，诊断构建标识为 `victarry-release-v1.11.3-20261026`。应用标识与配置路径保持原值，以延续现有配置。

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

## fork 发行包

首个独立发行版为 `v1.11.3`，仅提供 macOS Apple Silicon（arm64）DMG / ZIP，使用 ad-hoc 签名且未公证。版本在 Cargo workspace、前端 package / lock 和 Tauri 配置中同步。发布说明见 `docs/release/v1.11.3-notes.md`。

先完成上述检查并运行 `node scripts/relaunch-local.mjs`，随后提交源码，确认工作区干净，再运行 `node scripts/package-fork-release.mjs`。脚本只读取源码和当前主机的原生构建产物，不复制已安装应用或任何用户配置；产出位于 `dist/releases/v<版本>/`。目录已存在时停止，保留原产物。

发布时推送已核验的 main 和对应 annotated tag，先将 DMG、ZIP、`BUILD-INFO.json`、`SHA256SUMS.txt` 与 `latest.json` 上传到草稿，逐项检查附件及元数据后再公开并设为 Latest。原仓库的自动签名发布流程不在 fork 的 published 事件上执行；需要使用时可显式手动触发。未来新增平台时先验证对应二进制，再列入发行附件。

## 保存侧边聊天为正式聊天

临时侧边聊天上方提供「保存为正式聊天」。回复结束且缓存历史完整时，将全部已加载轮次保存为同一主机的新正式聊天，并自动打开。原侧边聊天继续保留。相同内容重复保存会打开已保存的副本；历史发生变化后可另存新副本。

按钮行与原生聊天区域共用纵向 flex 高度，聊天区域只占剩余空间，底部输入框不会因新增按钮行溢出。布局样式随入口一起移除，禁用增强或重载拓展时自动恢复原生布局。

使用原生 paginated rollout 与 `item_completed` 保存正文、命令及输出、MCP 参数和结果、搜索、可见推理摘要等。其他记录保留为可读 JSON 条目，同时进入模型可见的已完成历史工具结果。保存只恢复历史，不重新执行工具或启动模型调用。按完整分页重新读取，逐条核对正文、轮次与已适配工具的结果后才报告成功。

新 rollout 放在该主机的 `CODEX_HOME/sessions/YYYY/MM/DD/`，权限 `0600`。完整缓存快照另存于 `CODEX_HOME/side-chat-saves/<新会话 ID>/snapshot.json`，目录 `0700`、文件 `0600`。失败后保留原聊天与快照，重试复用同一目标且不覆写已经运行的聊天。32 MiB 上限或历史缺页会明确失败，不截断内容。

适配当前 `ChatGPT.app 26.1021.31345` 的本机 / SSH macOS、Linux 主机；原生私有模块改变时需要重新适配，未适配的构建不会尝试写入。临时会话服务端未提供的原始模型上下文、加密推理和已移出缓存的内容无法还原；附件保留原有内容与引用，本地路径不会伪装成已复制的文件。

已有管理器正在承载模型请求时，可用 `node scripts/build-side-chat-save-extension.mjs <用户拓展目录>/side-chat-save.js` 生成同源兼容拓展并热重载。它只补充按钮扫描，不修改认证或模型路由；新内置版本启动后自动停止兼容观察器。内置与兼容拓展共用同一分片，生成文件不需要单独维护。

```sh
node --test apps/codex-plus-manager/src/side-chat-save.test.ts
```

## 会话轮次与模型调用计数

用量状态栏显示 `会话 6 轮 · 模型 本轮 12 / 累计 183`，工具请求另行统计（见下节）：轮数按所选主机的 rollout 中的 `turn_id` 去重，次数为有真实输入 / 输出用量的已完成模型调用。工具执行、重复 token_count、限额刷新、上下文估算与 context-full 哨兵不会新增调用。失败或未写出用量的网络重试不在此计数中，不能把它当作网关账单的 HTTP 请求总数。

首次按最多 8 MiB / 次扫描历史，预热时显示“会话统计中…”，之后只消费新增字节；按文件路径隔离、有界缓存，并在文件截断、替换或检测到改写后重建。半行保留到续写完整，超大工具输出不保存在缓存。缺少可靠轮次显示 `—`，无法确认完整性的用量显示 `≥` 下界。自动续跑也可能产生新的 Codex 任务轮次，轮数不是用户消息条数。

数据接入现有内置 `/thread-usage-live`，没有扩大第三方扩展路由白名单。支持该实例的本机会话和显式配置的 SSH 远端会话；不跨 profile 查询或借用其他主机会话的计数。

相关验证：

```sh
cargo test --locked --release -p codex-plus-data --lib usage_activity
cargo test --locked --release -p codex-plus-data --test storage_adapter
node --test apps/codex-plus-manager/src/usage-statusline.test.ts
```

## 分开显示模型与工具调用

状态栏分别显示 `模型 本轮 12 / 累计 183` 与 `工具 本轮 26 / 累计 420`。模型数仍来自去重后的真实输入 / 输出用量；工具数来自模型可见的外层 `function_call` / `custom_tool_call` 等工具请求，按 `call_id` 去重，内置搜索 / 生图等服务端工具按条目 ID 去重。

工具输出、`item_completed` 界面镜像、重复通知和批量执行内部子步骤不额外累加；失败或取消的外层工具请求仍计为一次工具请求。工具数与模型数完全独立，一个模型响应可以发出多个工具请求。旧 helper 缺少工具字段时显示 `—`，缺 ID 或条目过大无法完整统计时显示 `≥` 下界。

## SSH 远端用量状态栏

内置状态栏现在也显示 session 累计输入与输出 token。SSH 会话需要显式配置主机映射；未配置的 host 不会建立统计 SSH 连接，也不会回退到本机同 UUID 的日志。配置文件位于 macOS/Linux 的 `$XDG_CONFIG_HOME/Codex++/remote-usage-hosts.json`（未设置时为 `~/.config/Codex++/`），Windows 为 `%APPDATA%/Codex++/`：

```json
{
  "version": 1,
  "hosts": [
    { "host_id": "remote-ssh-discovered:dev", "ssh_alias": "dev", "profile_dir": ".codex" },
    { "host_id": "remote-ssh-discovered:dev-kth", "ssh_alias": "dev-kth", "profile_dir": ".codex-kth" }
  ]
}
```

`host_id` 必须与 Codex 连接身份一致；手工添加的连接可能使用不同 ID。`ssh_alias` 必须是已有的无交互 SSH 配置，远端登录 shell 需先选择正确 `CODEX_HOME`。`profile_dir` 是远端用户目录下的 profile 名称；采集器校验有效 `CODEX_HOME` 与其一致，SQLite 和 rollout 路径均不得越出该 profile。配置文件不放 API key 或 SSH 私钥；建议权限 `0600`。

采集器经已有 SSH 启动 Python 3 标准库程序，通过 stdio 交换数据。远端无需安装插件、修改认证、写入文件、重启 app-server 或开放端口。只传回用量数字、时间戳、轮次和工具 ID 等计数元数据，不传提示词、工具参数或输出。每 host 复用连接；增量读取最多 8 MiB / 512 条元数据，每行上限 256 KiB，缓存和响应大小有界。两端缓存逐出及日志改写均触发重新扫描；预热期间显示“会话统计中…”。首次读取大历史需要多个轮询周期。

前端缓存及请求按 `(host_id, session_id)` 隔离；来源显示在状态栏悬浮提示中。断线时保留对应会话的最近读数并标记，重连后继续读取。模型 / 工具口径复用本机 Rust 计数器；TPS 仍是用量事件间隔估算，并非服务端纯解码速度。原来的 `session-token-counter.js` 扩展应在检测到原生 `[data-usage="tokens"]` 时让位，避免显示两份累计用量。

当前客户端 sidebar 的 `local:<uuid>` 是会话种类键，SSH 也使用该格式；统计栏从成对的会话 ID 与物理 `hostId` 识别来源，不能把 `local:` 当作本机证据。嵌套 composer 从当前 form 获取 portal；侧栏隐藏时也可使用当前 composer 的成对元数据。冲突和新会话草稿仍拒绝取数。此兼容模式只由统计栏显式启用，其他会话操作保留原有冲突策略。

新会话发送后，原生客户端可能继续保留 `client-new-thread:…` 作为输入框或侧栏的稳定键。统计栏通过当前输入框 / route 的临时身份，与同一条元数据中的 `clientThreadId + conversationId + hostId` 建立正式会话关联；同时兼容原生 sidebar 的 `{key, summary: {id, hostId}}` 条目及指向正式 UUID 的链接。没有明确关联时不借用旧选中行或把临时 ID 后半段当成正式 UUID。已有轮询会重新读取元数据，侧栏插入及链接更新也触发刷新，无需重新打开聊天。

本机诊断日志 `renderer.usage_statusline_state` 只记录每次会话的 waiting / scanning / ready 阶段、主机类别和是否已有 token，不记录 UUID、提示词或工具正文，可用于区分取数测试与真实窗口挂载。

升级已打开的多开窗口时，内部 `--codex-plus-multi-worker-resume <worker-options.json>` 模式只恢复后台增强，不启动或重启 Codex。它需要原实例端点仍存活、相同隔离环境和原参数；普通使用继续通过管理器启动。退出旧 worker 与替换清单前必须核对 PID 和实例身份，不能把本机或其他 profile 的 worker 一并结束。

```sh
cargo test --locked --release -p codex-plus-data --lib remote_usage
cargo test --locked --release -p codex-plus-launcher --lib restore_
```

## 远端归档聊天入口

开启增强后，设置 → Archived chats 页的搜索框上方显示「主机」选择器，可切换「本机 / 云端」和当前已连接的 SSH 主机。它调用当前原生设置上下文的 `setSelectedHostId`；列表、分页、项目分组、搜索和取消归档均继续使用该主机的原生处理。主机选择与原生设置的主机范围一致。

实现位于 `89-archive-hosts.js`，只在识别到原生归档搜索框及匹配的 React 上下文时挂载。每次选择重新读取上下文，断开的旧主机不会被选中；没有可用远端、关闭增强或客户端结构不兼容时不显示入口。没有新增后端路由、复制聊天或修改官方应用包。

```sh
node --test apps/codex-plus-manager/src/archive-hosts.test.ts
```
