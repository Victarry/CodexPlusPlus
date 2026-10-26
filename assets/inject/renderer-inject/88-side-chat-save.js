  // 只适配已核对的原生构建。临时会话没有 rollout，不能直接 fork；
  // 将缓存中的完整轮次写成新的原生 rollout，再由同一主机的原生恢复入口接管。
  const codexSideSaveBuilds = {
    "app-initial-feb30b196d11.js": { init: "rSn", managers: "Dxn", allManagers: "Oxn", resumeInputs: "Xzn", registerHost: "Dqn" },
  };
  const codexSideSaveState = window.__codexPlusSideChatSaveState ||= { jobs: new Map(), saved: new Map(), pending: new Map() };
  const codexSideSaveMaxBytes = 32 * 1024 * 1024;
  const codexSideSaveFormatVersion = 2;

  function codexSideSaveTurns(conversation) {
    const history = conversation?.turnHistory;
    if (history?.kind === "canonical") {
      const data = history.history;
      if (!data?.isComplete || data.islands.length !== 1) throw new Error("侧边聊天历史尚未完整加载，请加载历史后再保存");
      return data.islands.flatMap((island) => island.entries.map((entry) => {
        const turn = data.entitiesByKey[entry.value];
        if (!turn) throw new Error("侧边聊天历史存在缺页，已停止保存");
        return turn;
      }));
    }
    if (conversation?.turnsPagination?.hasLoadedOldest === false) throw new Error("侧边聊天历史尚未完整加载，请加载历史后再保存");
    return conversation?.turns || [];
  }

  function codexSideSaveSnapshot(conversation, hostId) {
    if (!conversation || conversation.ephemeral !== true || conversation.sideConversation !== true
        || conversation.hostId !== hostId) throw new Error("侧边聊天身份已变化，请重新打开保存入口");
    const turns = codexSideSaveTurns(conversation);
    if (!turns.length) throw new Error("侧边聊天还没有可保存的历史");
    if (turns.some((turn) => turn.status === "inProgress" || turn.itemsPagination?.hasLoadedOldest === false)
        || conversation.unconfirmedTurnSubmissions?.some((item) => item.terminal !== true)) {
      throw new Error("请等待侧边聊天回复结束、历史加载完成后再保存");
    }
    if (conversation.requests?.length) throw new Error("侧边聊天仍有待处理请求，请处理完后再保存");
    // 不保存 manager、认证、供应商配置或完整运行时对象。轮次与工具负载只进入私有历史文件。
    const value = JSON.parse(JSON.stringify({
      version: 1, sourceId: conversation.id, hostId, cwd: conversation.cwd,
      title: conversation.title || "已保存的侧边聊天", model: conversation.latestModel,
      modelProvider: conversation.modelProvider || "openai", effort: conversation.latestReasoningEffort,
      collaborationMode: conversation.latestCollaborationMode,
      parentId: conversation.forkedFromId,
      workspaceKind: conversation.workspaceKind, projectlessOutputDirectory: conversation.projectlessOutputDirectory,
      permissions: conversation.currentPermissions, parentNavigationPath: conversation.sideConversationParentNavigationPath,
      createdAt: conversation.createdAt, turns: turns.map((turn) => ({
        turnId: turn.turnId, status: turn.status, turnStartedAtMs: turn.turnStartedAtMs,
        durationMs: turn.durationMs, error: turn.error, items: turn.items,
        params: { input: turn.params?.input, model: turn.params?.model, effort: turn.params?.effort,
          attachments: turn.params?.attachments, commentAttachments: turn.params?.commentAttachments,
          additionalContext: turn.params?.additionalContext },
        localMetadata: turn.localMetadata, mcpAppModelContextAttachments: turn.mcpAppModelContextAttachments,
      })),
    }));
    if (!value.cwd || !value.model) throw new Error("侧边聊天缺少工作目录或模型信息，已停止保存");
    if (new TextEncoder().encode(JSON.stringify(value)).length > codexSideSaveMaxBytes) {
      throw new Error("侧边聊天超过 32 MiB 保存上限；已停止保存，没有截断历史");
    }
    return value;
  }

  function codexSideSaveText(item) {
    return (item.content || []).filter((part) => part.type === "text").map((part) => part.text || "").join("\n");
  }

  function codexSideSaveDuration(ms) {
    const value = Math.max(0, Number(ms) || 0);
    return { secs: Math.floor(value / 1000), nanos: Math.floor(value % 1000 * 1000000) };
  }

  function codexSideSavePathUri(path) {
    if (path.startsWith("file:")) return path;
    const url = new URL("file:///");
    url.pathname = path;
    return url.href;
  }

  // 只做 argv 解码用于重建历史展示，不经过 shell、更不会执行命令。
  function codexSideSaveArgv(command) {
    const words = []; let word = "", quote = "", escaped = false, started = false;
    for (const char of command) {
      if (escaped) { word += char; escaped = false; started = true; continue; }
      if (char === "\\" && quote !== "'") { escaped = true; started = true; continue; }
      if (quote) { if (char === quote) quote = ""; else word += char; started = true; continue; }
      if (char === "'" || char === '"') { quote = char; started = true; continue; }
      if (/\s/.test(char)) { if (started) words.push(word); word = ""; started = false; }
      else { word += char; started = true; }
    }
    if (quote || escaped) return [command];
    if (started) words.push(word);
    return words.length ? words : [command];
  }

  function codexSideSaveCoreItem(item, cwd, fallbackId) {
    const id = item.id || fallbackId;
    if (item.type === "userMessage") return { item: { type: "UserMessage", id, client_id: item.clientId || null,
      content: (item.content || []).map((part) => {
        if (part.type === "text") return { type: "text", text: part.text || "", text_elements: (part.textElements || part.text_elements || []).map((span) => ({ byte_range: span.byteRange || span.byte_range, ...(span.placeholder == null ? {} : { placeholder: span.placeholder }) })) };
        if (part.type === "image") return { type: "image", image_url: part.imageUrl || part.image_url || part.url, ...(part.detail ? { detail: part.detail } : {}) };
        if (part.type === "localImage" || part.type === "local_image") return { type: "local_image", path: part.path, ...(part.detail ? { detail: part.detail } : {}) };
        return { ...part, type: part.type === "localAudio" ? "local_audio" : part.type,
          ...(part.audioUrl ? { audio_url: part.audioUrl } : {}) };
      }) } };
    if (item.type === "agentMessage") return { item: { type: "AgentMessage", id,
      content: [{ type: "Text", text: item.text || "" }], phase: item.phase || null,
      memory_citation: item.memoryCitation || null, ...(item.delivery ? { delivery: item.delivery } : {}) } };
    if (item.type === "commandExecution") return { item: { type: "CommandExecution", id,
      command: codexSideSaveArgv(item.command || ""), cwd: codexSideSavePathUri(item.cwd || cwd),
      parsed_cmd: [{ type: "unknown", cmd: item.command || "" }],
      source: (item.source || "agent").replace(/[A-Z]/g, (char) => "_" + char.toLowerCase()),
      status: item.status || "completed", aggregated_output: item.aggregatedOutput ?? null,
      exit_code: item.exitCode ?? null, duration: codexSideSaveDuration(item.durationMs),
      ...(item.processId ? { process_id: item.processId } : {}) } };
    if (item.type === "reasoning") return { item: { type: "Reasoning", id,
      summary_text: item.summary || [], raw_content: item.content || [] } };
    if (item.type === "mcpToolCall") return { item: { type: "McpToolCall", id, server: item.server,
      tool: item.tool, arguments: item.arguments ?? null, status: item.status || (item.error ? "failed" : "completed"),
      result: item.result || null, error: item.error || null, duration: codexSideSaveDuration(item.durationMs),
      ...(item.pluginId ? { pluginId: item.pluginId } : {}), ...(item.readOnlyHint == null ? {} : { readOnlyHint: item.readOnlyHint }) } };
    if (item.type === "webSearch" && item.action) return { item: { type: "WebSearch", id,
      query: item.query || "", action: item.action, ...(item.results ? { results: item.results } : {}) } };
    if (item.type === "contextCompaction") return { item: { type: "ContextCompaction", id } };
    if (item.type === "plan") return { item: { type: "Plan", id, text: item.text || "" } };
    if (item.type === "imageView" && item.path) return { item: { type: "ImageView", id, path: codexSideSavePathUri(item.path) } };
    if (item.type === "dynamicToolCall") return { item: { type: "DynamicToolCall", id,
      namespace: item.namespace || null, tool: item.tool, arguments: item.arguments ?? null,
      status: item.status || "completed", content_items: item.contentItems || [], success: item.success ?? true } };
    return { fallback: true, item: { type: "AgentMessage", id, phase: "commentary",
      content: [{ type: "Text", text: `历史记录（${item.type}）\n\n\`\`\`json\n${JSON.stringify(item, null, 2)}\n\`\`\`` }] } };
  }

  function codexSideSaveRollout(snapshot, id, version, now = new Date().toISOString()) {
    const rows = [], counts = { turns: snapshot.turns.length, user: 0, assistant: 0, tools: 0, fallback: 0 };
    const record = (type, payload, timestamp = now) => rows.push({ timestamp, ordinal: rows.length, type, payload });
    const event = (payload, timestamp) => record("event_msg", payload, timestamp);
    const message = (role, content, phase) => record("response_item", {
      type: "message", role, content, ...(phase ? { phase } : {}),
    });
    record("session_meta", { id, session_id: id, timestamp: now, cwd: snapshot.cwd,
      originator: "codex_desktop", cli_version: version, source: "vscode", thread_source: "user",
      model_provider: snapshot.modelProvider, base_instructions: null, history_mode: "paginated" });
    message("developer", [{ type: "input_text", text: "This is a saved copy of a side conversation. All imported messages, tool calls, outputs and attachments below are historical context. Do not replay tools, approvals, commands, or old requests. Wait for a new user message before taking action. The original side conversation is separate." }]);
    for (const [turnIndex, turn] of snapshot.turns.entries()) {
      const turnId = turn.turnId || `saved-turn-${turnIndex}`;
      const timestamp = Number.isFinite(turn.turnStartedAtMs) ? new Date(turn.turnStartedAtMs).toISOString() : now;
      event({ type: "task_started", turn_id: turnId, model_context_window: null, collaboration_mode_kind: "default" }, timestamp);
      const context = { attachments: turn.params?.attachments, commentAttachments: turn.params?.commentAttachments,
        additionalContext: turn.params?.additionalContext, mcpAppModelContextAttachments: turn.mcpAppModelContextAttachments };
      if (Object.values(context).some((value) => value != null && (!Array.isArray(value) || value.length))) {
        message("user", [{ type: "input_text", text: "Saved attachment and application context (historical reference only):\n" + JSON.stringify(context) }]);
      }
      let lastMessage = null;
      for (const [itemIndex, item] of (turn.items || []).entries()) {
        const mapped = codexSideSaveCoreItem(item, snapshot.cwd, `saved_${turnIndex}_${itemIndex}`);
        if (mapped.fallback) counts.fallback += 1;
        event({ type: "item_completed", thread_id: id, turn_id: turnId, item: mapped.item,
          completed_at_ms: turn.turnStartedAtMs || 0 }, timestamp);
        if (item.type === "userMessage") {
          counts.user += 1;
          const text = codexSideSaveText(item);
          const images = (item.content || []).filter((part) => part.type === "image").map((part) => part.imageUrl || part.image_url || part.url).filter(Boolean);
          const content = text ? [{ type: "input_text", text }] : [];
          for (const image of images) content.push({ type: "input_image", image_url: image });
          // 本地附件路径和结构化标记保留在原始快照与上下文，不能把路径伪装成图像像素。
          const other = (item.content || []).filter((part) => !["text", "image"].includes(part.type));
          if (other.length) content.push({ type: "input_text", text: "Saved input attachments: " + JSON.stringify(other) });
          message("user", content.length ? content : [{ type: "input_text", text: "[Saved empty user input]" }]);
          continue;
        }
        if (item.type === "agentMessage") {
          counts.assistant += 1;
          lastMessage = item.text || "";
          message("assistant", [{ type: "output_text", text: lastMessage }], item.phase);
          continue;
        }
        // 每个非正文条目都保留完整 JSON，模型上下文使用已配对的历史工具结果；不会执行它。
        const callId = `saved_${turnIndex}_${itemIndex}`;
        record("response_item", { type: "function_call", call_id: callId, name: "codex_saved_history", arguments: JSON.stringify({ type: item.type, id: item.id }) });
        record("response_item", { type: "function_call_output", call_id: callId, output: JSON.stringify(item) });
        if (["commandExecution", "mcpToolCall", "webSearch", "dynamicToolCall", "fileChange"].includes(item.type)) counts.tools += 1;
      }
      event({ type: "task_complete", turn_id: turnId, last_agent_message: lastMessage,
        duration_ms: turn.durationMs ?? null }, timestamp);
    }
    const body = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    if (new TextEncoder().encode(body).length > codexSideSaveMaxBytes) throw new Error("生成的历史超过 32 MiB；已停止保存，没有截断历史");
    return { body, counts };
  }

  function codexSideSaveBase64(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
    return btoa(binary);
  }

  async function codexSideSaveFingerprint(snapshot) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(snapshot)));
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function codexSideSaveRuntime() {
    const discovered = [...document.querySelectorAll("script[src],link[href]")].map((node) => node.src || node.href)
      .concat((performance.getEntriesByType("resource") || []).map((entry) => entry.name));
    const candidate = discovered.find((url) => /\/app-initial-[\w-]+\.js$/.test(url));
    const filename = candidate?.split("/").pop() || "app-initial-feb30b196d11.js";
    const binding = codexSideSaveBuilds[filename];
    if (!binding) throw new Error("当前 Codex 客户端尚未适配保存侧边聊天，请更新 Codex++");
    const native = await import(`app://-/assets/${filename}`);
    if (typeof native[binding.init] !== "function" || typeof native[binding.resumeInputs] !== "function"
        || typeof native[binding.registerHost] !== "function") throw new Error("原生聊天接口不兼容，已停止保存");
    native[binding.init]();
    return { native, binding };
  }

  function codexSideSaveScopes(panel) {
    const scopes = [], fibers = new Set();
    const seeds = [panel.querySelector?.("[contenteditable]"), panel];
    for (const seed of seeds) for (let node = seed; node; node = node.parentElement) {
      const key = Object.keys(node).find((name) => name.startsWith("__reactFiber$"));
      for (let fiber = key && node[key], depth = 0; fiber && depth++ < 100 && !fibers.has(fiber); fiber = fiber.return) {
        fibers.add(fiber);
        for (let hook = fiber.memoizedState, index = 0; hook && index++ < 200; hook = hook.next) {
          const scope = hook.memoizedState?.current;
          if (typeof scope?.get === "function" && scope.value?.routeKind === "local-thread" && !scopes.includes(scope)) scopes.push(scope);
        }
      }
    }
    return scopes;
  }

  async function codexSideSaveContext(panel, runtime) {
    const sourceId = panel?.getAttribute("data-tab-id")?.match(/^sidechat:([0-9a-f-]{36})$/i)?.[1];
    if (!sourceId || !panel.isConnected) throw new Error("侧边聊天已关闭，请重新打开后保存");
    const { native, binding } = runtime;
    const matches = new Map();
    for (const scope of codexSideSaveScopes(panel)) {
      // route.hostId 在原生本机/SSH 聊天中均可能为 null。只接受当前注册中心里
      // 真正持有该临时聊天的 manager；同 UUID 多主机时拒绝猜测或回退本机。
      for (const manager of scope.get(native[binding.allManagers]) || []) {
        const hostId = manager.getHostId(), conversation = manager.getConversation(sourceId);
        if (hostId !== "durable" && conversation?.id === sourceId && conversation.hostId === hostId
            && conversation.sideConversation === true && conversation.ephemeral === true && !matches.has(hostId)) {
          matches.set(hostId, { scope, hostId, manager, conversation, sourceId, native, binding });
        }
      }
    }
    if (matches.size > 1) throw new Error("侧边聊天存在冲突的主机身份，已停止保存");
    if (matches.size === 1) return matches.values().next().value;
    throw new Error("侧边聊天的主机连接尚未就绪，已停止保存");
  }

  async function codexSideSaveCommand(manager, command, cwd) {
    const path = command.at(-1), root = command[1] === "700" ? path : path.slice(0, path.lastIndexOf("/"));
    // 元数据保存不继承模型命令的默认只读沙箱。只给固定 chmod 命令开放
    // 新建目录的写权限，并保持网络关闭；不扩大源聊天或全局权限。
    const result = await manager.sendRequest("command/exec", { command, cwd, timeoutMs: 10000,
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [root], networkAccess: false,
        excludeTmpdirEnvVar: true, excludeSlashTmp: true } });
    if (result.exitCode !== 0) throw new Error("无法设置历史文件的私有权限，已停止保存");
  }

  async function codexSideSaveReadHistory(manager, thread) {
    if (thread.historyMode !== "paginated") return thread;
    const turns = [], cursors = new Set(); let cursor = null;
    do {
      const page = await manager.sendRequest("thread/turns/list", { threadId: thread.id,
        cursor, limit: 100, itemsView: "notLoaded", sortDirection: "asc" });
      for (const turn of page.data) {
        const items = [], itemCursors = new Set(); let itemCursor = null;
        do {
          const details = await manager.sendRequest("thread/items/list", { threadId: thread.id, turnId: turn.id,
            cursor: itemCursor, limit: 100, sortDirection: "asc" });
          items.push(...details.data.map((entry) => entry.item || entry));
          itemCursor = details.nextCursor;
          if (itemCursor && itemCursors.has(itemCursor)) throw new Error("历史分页没有前进，已停止验证");
          itemCursors.add(itemCursor);
        } while (itemCursor);
        turns.push({ ...turn, items });
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("历史分页没有前进，已停止验证");
      cursors.add(cursor);
    } while (cursor);
    return { ...thread, turns };
  }

  function codexSideSaveCanonical(value) {
    if (Array.isArray(value)) return value.map(codexSideSaveCanonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, codexSideSaveCanonical(value[key])]));
    return value;
  }

  function codexSideSaveProjection(value, original) {
    if (Array.isArray(value)) return value.map((entry, index) => codexSideSaveProjection(entry, original?.[index]));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .filter(([key, entry]) => entry !== null || Object.prototype.hasOwnProperty.call(original || {}, key))
      .map(([key, entry]) => [key, codexSideSaveProjection(entry, original?.[key])]));
    return value;
  }

  function codexSideSaveCheckHistory(snapshot, thread) {
    if (!thread || thread.ephemeral === true || !thread.path) throw new Error("新会话未确认持久化，原侧边聊天仍保留");
    const expected = snapshot.turns.flatMap((turn) => (turn.items || []).filter((item) => item.type === "userMessage" || item.type === "agentMessage")
      .map((item) => ({ role: item.type, text: item.type === "userMessage" ? codexSideSaveText(item) : item.text || "" })));
    const actual = (thread.turns || []).flatMap((turn) => (turn.items || []).filter((item) => item.type === "userMessage" || item.type === "agentMessage")
      .map((item) => ({ role: item.type, text: item.type === "userMessage" ? codexSideSaveText(item) : item.text || "" })));
    // 未识别条目的 JSON 镜像允许额外出现；原有消息必须逐条原样存在且保持顺序。
    let offset = 0;
    for (const item of expected) {
      while (offset < actual.length && (actual[offset].role !== item.role || actual[offset].text !== item.text)) offset += 1;
      if (offset >= actual.length) throw new Error("保存后的历史核对未通过；原侧边聊天和私有快照仍保留");
      offset += 1;
    }
    if ((thread.turns || []).length !== snapshot.turns.length) throw new Error("保存后的轮次数不一致；原侧边聊天和私有快照仍保留");
    const restored = new Map((thread.turns || []).flatMap((turn) => turn.items || []).map((item) => [item.id, item]));
    for (const item of snapshot.turns.flatMap((turn) => turn.items || [])) {
      if (!["commandExecution", "mcpToolCall", "dynamicToolCall", "webSearch", "reasoning", "contextCompaction", "plan", "imageView"].includes(item.type)) continue;
      const copy = restored.get(item.id);
      if (!copy || copy.type !== item.type) throw new Error("保存后的工具或上下文记录不完整；原聊天与快照仍保留");
      const fields = { commandExecution: ["aggregatedOutput", "exitCode"], mcpToolCall: ["arguments", "result", "error"],
        dynamicToolCall: ["arguments", "contentItems", "success"], reasoning: ["summary", "content"], webSearch: ["query", "action", "results"] }[item.type] || [];
      for (const field of fields) {
        if (JSON.stringify(codexSideSaveCanonical(item[field] ?? null)) !== JSON.stringify(codexSideSaveCanonical(codexSideSaveProjection(copy[field] ?? null, item[field])))) {
          throw new Error("保存后的工具输出核对未通过；原聊天与快照仍保留");
        }
      }
    }
  }

  async function codexSideSavePersist(context, snapshot, onProgress = () => {}) {
    const { manager, scope, native, binding, hostId } = context;
    const fingerprint = await codexSideSaveFingerprint(snapshot), key = `paginated-${codexSideSaveFormatVersion}:${hostId}:${snapshot.sourceId}:${fingerprint}`;
    const previous = codexSideSaveState.saved.get(key);
    if (previous) { native[binding.registerHost](scope, previous.id, hostId); return previous; }
    const home = await manager.getCodexHome();
    if (typeof home !== "string" || !home.startsWith("/") || home.includes("\0")) throw new Error("目前仅支持本机和 SSH 的 macOS / Linux 聊天保存");
    let candidate = codexSideSaveState.pending.get(key);
    if (!candidate) {
      const id = crypto.randomUUID(), date = new Date().toISOString(), root = home.replace(/\/$/, "");
      const directory = `${root}/side-chat-saves/${id}`, sessionDirectory = `${root}/sessions/${date.slice(0, 10).replaceAll("-", "/")}`;
      candidate = { id, date, directory, sessionDirectory,
        rolloutPath: `${sessionDirectory}/rollout-${date.slice(0, 19).replaceAll(":", "-")}-${id}.jsonl`, snapshotPath: `${directory}/snapshot.json`, started: false };
      codexSideSaveState.pending.set(key, candidate);
    }
    const { id, date, directory, sessionDirectory, rolloutPath, snapshotPath } = candidate;
    const version = manager.requestClient?.getAppServerVersion?.();
    if (!version) throw new Error("无法确认原生服务版本，已停止保存");
    const rollout = codexSideSaveRollout(snapshot, id, version, date);
    onProgress("正在保存完整历史…");
    const write = async (path, body) => {
      await manager.sendRequest("fs/writeFile", { path, dataBase64: codexSideSaveBase64(body) });
      await codexSideSaveCommand(manager, ["chmod", "600", path], snapshot.cwd);
    };
    if (!candidate.started) {
      await manager.sendRequest("fs/createDirectory", { path: directory, recursive: true });
      await codexSideSaveCommand(manager, ["chmod", "700", directory], snapshot.cwd);
      await manager.sendRequest("fs/createDirectory", { path: sessionDirectory, recursive: true });
      await write(snapshotPath, JSON.stringify({ ...snapshot, savedId: id, fingerprint, savedAt: date, counts: rollout.counts }));
      await write(rolloutPath, rollout.body);
      // 写后逐字读回，先核对落盘内容；从不覆写源会话或已经恢复运行的目标文件。
      const stored = await manager.sendRequest("fs/readFile", { path: rolloutPath });
      if (stored.dataBase64 !== codexSideSaveBase64(rollout.body)) throw new Error("历史文件写入核对失败，原侧边聊天仍保留");
      candidate.started = true;
    }
    onProgress("正在验证正式聊天…");
    const response = await manager.sendRequest("thread/resume", { threadId: id, path: rolloutPath,
      model: snapshot.model, modelProvider: snapshot.modelProvider, excludeTurns: true });
    codexSideSaveCheckHistory(snapshot, await codexSideSaveReadHistory(manager, response.thread));
    await manager.sendRequest("thread/name/set", { threadId: id, name: snapshot.title });
    const resume = await manager.resumeConversation({ conversationId: id, model: snapshot.model,
      reasoningEffort: snapshot.effort || null, permissions: snapshot.permissions,
      workspaceRoots: snapshot.permissions?.runtimeWorkspaceRoots || [snapshot.cwd] },
    { readResumeInputs: native[binding.resumeInputs](scope, hostId) });
    if (resume.status !== "ready" || manager.getConversation(id)?.ephemeral !== false) throw new Error("正式聊天未能重新打开；原聊天与保存文件仍保留");
    const reread = await manager.sendRequest("thread/read", { threadId: id, includeTurns: false });
    codexSideSaveCheckHistory(snapshot, await codexSideSaveReadHistory(manager, reread.thread));
    const parentId = snapshot.parentId || snapshot.parentNavigationPath?.match(/\/local\/([0-9a-f-]{36})/)?.[1] || snapshot.sourceId;
    const assignment = await manager.getThreadProjectAssignment(parentId);
    if (assignment !== undefined && manager.threadWorkspaceStorage?.setProjectAssignment) await manager.threadWorkspaceStorage.setProjectAssignment(id, assignment);
    native[binding.registerHost](scope, id, hostId);
    const result = { id, hostId, fingerprint, sourceId: snapshot.sourceId, snapshotPath, rolloutPath, counts: rollout.counts };
    codexSideSaveState.saved.set(key, result);
    codexSideSaveState.pending.delete(key);
    return result;
  }

  async function codexSideSaveOpen(result) {
    const shared = await import("app://-/assets/app-shared-2cae01273bae.js");
    if (typeof shared.SIt?.dispatchHostMessage !== "function") throw new Error("原生导航接口尚未就绪；正式聊天已经保存，可从侧栏打开");
    shared.SIt.dispatchHostMessage({ type: "navigate-to-route", path: `/local/${result.id}` });
  }

  async function codexSideSaveActivate(panel, button) {
    const tabId = panel.getAttribute("data-tab-id");
    if (codexSideSaveState.jobs.has(tabId)) return;
    const job = (async () => {
      button.disabled = true;
      try {
        const runtime = await codexSideSaveRuntime(), context = await codexSideSaveContext(panel, runtime);
        const snapshot = codexSideSaveSnapshot(context.manager.getConversation(context.sourceId), context.hostId);
        const result = await codexSideSavePersist(context, snapshot, (message) => { button.textContent = message; });
        button.textContent = "打开正式聊天";
        showToast(`已保存并验证：${result.counts.turns} 轮聊天。原侧边聊天仍保留。`, { type: "success" });
        if (panel.isConnected) await codexSideSaveOpen(result);
      } catch (error) {
        button.textContent = "保存为正式聊天";
        // 不把原始服务端错误写入 toast 或诊断，避免历史正文进入普通日志。
        const message = String(error?.message || "保存失败");
        showToast(/^[\u4e00-\u9fff]/.test(message) ? message : "保存未完成；原侧边聊天仍保留，请检查主机连接后重试", { type: "warn" });
      } finally { button.disabled = false; }
    })();
    codexSideSaveState.jobs.set(tabId, job);
    try { await job; } finally { codexSideSaveState.jobs.delete(tabId); }
  }

  function syncCodexSideChatSaveButtons() {
    if (codexPlusBackendSettings.enhancementsEnabled === false) {
      document.querySelectorAll("[data-codex-plus-side-save]").forEach((node) => node.remove());
      return;
    }
    for (const panel of document.querySelectorAll('[role="tabpanel"][data-tab-id^="sidechat:"]')) {
      if (!/^sidechat:[0-9a-f-]{36}$/i.test(panel.getAttribute("data-tab-id") || "") || panel.querySelector("[data-codex-plus-side-save]")) continue;
      const row = document.createElement("div");
      row.setAttribute("data-codex-plus-ext", "side-chat-save");
      row.setAttribute("data-codex-plus-side-save", "true");
      row.className = "no-drag flex shrink-0 items-center justify-end border-b border-primary-outline px-3 py-1";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "rounded-md px-2 py-1 text-sm text-secondary hover:bg-surface-hover hover:text-default";
      button.textContent = "保存为正式聊天";
      button.title = "将已加载的全部历史保存为独立正式聊天；保留原侧边聊天";
      button.addEventListener("click", () => { void codexSideSaveActivate(panel, button); });
      row.append(button);
      panel.prepend(row);
    }
  }

  // 旧管理器可用同源用户拓展热加载此功能。新内置版本接管时停止兼容观察器，
  // 避免重复入口；不重启正在转发模型请求的管理器或官方聊天进程。
  if (typeof codexSideSaveExtensionMode === "undefined") {
    codexSideSaveState.builtinVersion = codexSideSaveFormatVersion;
    codexSideSaveState.extensionCleanup?.();
  }
