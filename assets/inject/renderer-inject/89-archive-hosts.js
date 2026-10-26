  // 原生归档页按 selectedHostId 查询，桌面设置没有提供 SSH 主机入口。
  // 复用原生设置 hook 的上下文；列表、分页、搜索及取消归档仍由原生组件处理。
  function codexArchiveHostContextValue(value) {
    return value && typeof value === "object"
      && typeof value.selectedHostId === "string"
      && typeof value.setSelectedHostId === "function"
      && Array.isArray(value.connectedRemoteConnections) ? value : null;
  }

  function codexArchiveHostContext(anchor) {
    const key = Object.getOwnPropertyNames(anchor || {}).find((name) => name.startsWith("__reactFiber$"));
    let fiber = key ? anchor[key] : null;
    for (let depth = 0; fiber && depth < 32; depth += 1, fiber = fiber.return) {
      // React Compiler 的 useMemoCache 保存原生 useSettingsHost 返回值。
      for (const cache of (fiber.updateQueue?.memoCache?.data || []).slice(0, 32)) {
        if (!Array.isArray(cache)) continue;
        for (const value of cache.slice(0, 256)) {
          const context = codexArchiveHostContextValue(value);
          if (context) return context;
        }
      }
      // 兼容未使用 Compiler 的 useMemo / useRef 形态。
      let hook = fiber.memoizedState;
      for (let index = 0; hook && index < 32; index += 1, hook = hook.next) {
        const state = hook.memoizedState;
        for (const value of [state, state?.current, ...(Array.isArray(state) ? state.slice(0, 32) : [])]) {
          const context = codexArchiveHostContextValue(value);
          if (context) return context;
        }
      }
    }
    return null;
  }

  function codexArchiveHostOptions(context) {
    const options = new Map([["local", "本机 / 云端"]]);
    for (const connection of context?.connectedRemoteConnections || []) {
      const hostId = connection?.hostId;
      if (typeof hostId !== "string" || !hostId.trim() || hostId === "local" || hostId === "durable") continue;
      const label = typeof connection.displayName === "string" ? connection.displayName.trim() : "";
      options.set(hostId, label || hostId);
    }
    return Array.from(options, ([value, label]) => ({ value, label }));
  }

  function selectCodexArchiveHost(context, hostId) {
    if (!context || !codexArchiveHostOptions(context).some((option) => option.value === hostId)) return false;
    if (context.selectedHostId !== hostId) context.setSelectedHostId(hostId);
    return true;
  }

  function syncCodexArchiveHostSelector() {
    const id = "codex-plus-archive-hosts";
    const existing = document.getElementById(id);
    const anchor = document.getElementById("archived-tasks-search");
    const context = anchor && codexArchiveHostContext(anchor);
    const options = codexArchiveHostOptions(context);
    const container = anchor?.parentElement?.parentElement?.parentElement;
    // 只在已识别的原生归档页挂载；版本变化时保留原页面。
    if (codexPlusBackendSettings.enhancementsEnabled === false || !context || options.length < 2
        || !container?.classList.contains("sticky")) {
      existing?.remove();
      return;
    }
    let row = existing;
    if (!row || row.parentElement !== container) {
      existing?.remove();
      row = document.createElement("label");
      row.id = id;
      row.setAttribute("data-codex-plus-ext", "archive-hosts");
      row.className = "no-drag flex items-center gap-2 pb-3 text-sm text-secondary";
      const caption = document.createElement("span");
      caption.textContent = "主机";
      const select = document.createElement("select");
      select.setAttribute("aria-label", "归档聊天主机");
      select.className = "min-w-0 rounded-md border border-primary-outline bg-surface px-2 py-1 text-sm text-default";
      select.style.maxWidth = "100%";
      select.addEventListener("change", () => {
        // 每次操作重新读取当前树，不能使用上一次渲染或账号的回调。
        const current = codexArchiveHostContext(document.getElementById("archived-tasks-search"));
        if (!selectCodexArchiveHost(current, select.value)) {
          showToast("主机连接已变化，请重新选择", { type: "warn" });
        }
        scheduleScan();
      });
      row.append(caption, select);
      container.insertBefore(row, container.firstChild);
    }
    const select = row.querySelector("select");
    const signature = JSON.stringify(options);
    if (select.dataset.hostOptions !== signature) {
      select.replaceChildren(...options.map(({ value, label }) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        return option;
      }));
      select.dataset.hostOptions = signature;
    }
    select.value = context.selectedHostId;
  }
