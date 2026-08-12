(function () {
  "use strict";

  const POLL_INTERVAL_MS = 60_000;
  const ACTION_REFRESH_MS = 800;
  const state = {
    status: null,
    fetching: false,
    metricBaselines: new Map(),
    pendingAccounts: new Set(),
    pendingHeartbeats: new Set(),
    pendingBulk: new Set(),
  };

  const elements = {
    accounts: document.getElementById("accounts"),
    announcer: document.getElementById("announcer"),
    apiState: document.getElementById("apiState"),
    checkAll: document.getElementById("checkAll"),
    heartbeatAll: document.getElementById("heartbeatAll"),
    notice: document.getElementById("notice"),
    overallHealth: document.getElementById("overallHealth"),
    updated: document.getElementById("updated"),
  };

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function create(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function healthOf(value, fallback) {
    const raw = typeof value === "string" ? value : value?.health || value?.status || value?.state || value?.outcome;
    const normalized = String(raw || fallback || "unknown").toLowerCase();
    if (["success", "ok", "ready"].includes(normalized)) return "healthy";
    if (["failed", "failure", "error", "mismatch"].includes(normalized)) return "unhealthy";
    if (["healthy", "running", "stale", "unhealthy", "disabled", "unknown", "attention"].includes(normalized)) return normalized;
    return "unknown";
  }

  function dateValue(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function relativeTime(value) {
    const date = dateValue(value);
    if (!date) return "not yet";
    const difference = date.getTime() - Date.now();
    const absolute = Math.abs(difference);
    let count;
    let unit;
    if (absolute < 60_000) {
      count = Math.max(1, Math.round(absolute / 1_000));
      unit = "second";
    } else if (absolute < 3_600_000) {
      count = Math.round(absolute / 60_000);
      unit = "minute";
    } else if (absolute < 86_400_000) {
      count = Math.round(absolute / 3_600_000);
      unit = "hour";
    } else {
      count = Math.round(absolute / 86_400_000);
      unit = "day";
    }
    return new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "narrow" }).format(difference < 0 ? -count : count, unit);
  }

  function resetText(value) {
    const date = dateValue(value);
    if (!date) return "reset unavailable";
    return `resets ${new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date)}`;
  }

  function providerPresentation(provider) {
    const normalized = String(provider || "provider").toLowerCase();
    const labels = { codex: "Codex", claude: "Claude", grok: "Grok", fireworks: "Fireworks" };
    return {
      className: normalized.replace(/[^a-z0-9-]/g, ""),
      initial: (labels[normalized] || normalized).slice(0, 1).toUpperCase() || "P",
      label: labels[normalized] || normalized.replace(/(^|-)(\w)/g, (_, separator, letter) => `${separator ? " " : ""}${letter.toUpperCase()}`),
    };
  }

  function identityFor(account) {
    const identity = account.usage?.identity || {};
    const observed = identity.observed || {};
    const expected = identity.expected || {};
    const match = identity.match === "matched" ? true : identity.match === "mismatched" ? false : null;
    const details = [observed.email, observed.plan || observed.subscriptionType || observed.subscription, observed.organizationName]
      .filter(Boolean)
      .join(" · ");
    return { details: details || expected.email || "Identity unavailable", expected, match, observed };
  }

  function windowsFor(account) {
    return asArray(account.usage?.snapshot?.windows).map((window, index) => ({
      ...window,
      id: window.id || `window-${index}`,
    }));
  }

  function balancesFor(account) {
    return asArray(account.usage?.snapshot?.balances).map((balance, index) => ({
      ...balance,
      id: balance.id || `balance-${index}`,
      isBalance: true,
    }));
  }

  function heartbeatsFor(account) {
    return asArray(state.status?.heartbeats).filter((job) => job.accountId === account.id);
  }

  function heartbeatExecutionKey(job) {
    return [job.credentialSurfaceId, job.executor, job.provider || "", job.model, job.reasoning].join("\u0000");
  }

  function heartbeatGroupsFor(account) {
    const groups = new Map();
    heartbeatsFor(account).forEach((job) => {
      const key = heartbeatExecutionKey(job);
      const group = groups.get(key) || [];
      group.push(job);
      groups.set(key, group);
    });
    return [...groups.values()];
  }

  function combinedHeartbeat(group) {
    const running = group.find((job) => state.pendingHeartbeats.has(job.id) || job.inFlight || healthOf(job) === "running");
    const attempted = [...group]
      .filter((job) => attemptTime(job))
      .sort((left, right) => Date.parse(attemptTime(right)) - Date.parse(attemptTime(left)))[0];
    return { ...(running || attempted || group[0]), inFlight: Boolean(running), health: running ? "running" : healthOf(attempted || group[0]) };
  }

  function metricRemainingPercent(metric) {
    const value = metric.remainingPercent ??
      (metric.usedPercent == null ? null : 100 - Number(metric.usedPercent));
    if (value == null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : null;
  }

  function metricValue(metric) {
    const percent = metricRemainingPercent(metric);
    if (percent !== null) return `${Math.round(percent)}% left`;
    if (metric.formattedValue != null) return String(metric.formattedValue);
    if (metric.remaining != null) return String(metric.remaining);
    if (metric.value != null) return String(metric.value);
    if (metric.amount != null) {
      const amount = Number(metric.amount);
      if (Number.isFinite(amount) && metric.currency) {
        try {
          return new Intl.NumberFormat(undefined, { style: "currency", currency: metric.currency }).format(amount);
        } catch (_) {
          return `${amount} ${metric.currency}`;
        }
      }
      return metric.unit ? `${metric.amount} ${metric.unit}` : String(metric.amount);
    }
    if (metric.unit != null) return String(metric.unit);
    return "Unavailable";
  }

  function metricComparison(accountId, metric, currentPercent) {
    if (currentPercent === null) return null;
    const kind = metric.isBalance ? "balance" : "window";
    const key = `${accountId}\u0000${kind}\u0000${metric.id}`;
    const baseline = state.metricBaselines.get(key);
    if (baseline === undefined || currentPercent > baseline) {
      state.metricBaselines.set(key, currentPercent);
      return { baseline: currentPercent, consumed: 0 };
    }
    return { baseline, consumed: baseline - currentPercent };
  }

  function formatPercentagePoints(value) {
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: value < 1 ? 1 : 0,
    }).format(value);
  }

  function renderMetric(accountId, metric) {
    const percent = metricRemainingPercent(metric);
    const comparison = metricComparison(accountId, metric, percent);
    const consumedSinceOpen = comparison?.consumed || 0;
    const hasComparison = consumedSinceOpen >= 0.1;
    const band = percent === null ? "" : percent < 10 ? " critical" : percent < 25 ? " orange" : percent < 50 ? " yellow" : " green";
    const node = create("div", `metric${band}`);
    const line = create("div", "metric-line");
    const label = metric.label || metric.name || metric.id || "Usage";
    line.append(create("span", "metric-name", label));
    line.append(create("span", "metric-reset", metric.resetsAt ? resetText(metric.resetsAt) : metric.detail || ""));
    line.append(create("span", "metric-value", metricValue(metric)));
    node.append(line);

    if (percent !== null) {
      const bar = create("div", `remaining-bar${band}${hasComparison ? " has-comparison" : ""}`);
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-label", `${label} remaining`);
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "100");
      bar.setAttribute("aria-valuenow", String(percent));
      bar.style.setProperty("--remaining", `${percent}%`);
      bar.style.setProperty("--consumed-since-open", `${consumedSinceOpen}%`);
      const current = create("span", "remaining-bar-current");
      bar.append(current);
      if (hasComparison) {
        const points = formatPercentagePoints(consumedSinceOpen);
        const comparisonLabel = `${points} percentage points used since page opened`;
        const consumed = create("span", "remaining-bar-consumed");
        consumed.setAttribute("aria-hidden", "true");
        bar.append(consumed);
        bar.title = comparisonLabel;
        bar.setAttribute("aria-valuetext", `${metricValue(metric)}; ${comparisonLabel}`);
      }
      node.append(bar);
    }
    return node;
  }

  function attemptTime(operation) {
    return operation?.completedAt || operation?.lastAttemptAt || operation?.attemptedAt || operation?.lastSuccessAt;
  }

  function operationNode(label, operation, forcedRunning) {
    const health = forcedRunning || operation?.inFlight ? "running" : healthOf(operation, operation?.enabled === false ? "disabled" : "unknown");
    const node = create("div", `operation ${health}`);
    node.title = operation?.error?.message || (operation?.nextEligibleAt ? `Next eligible ${relativeTime(operation.nextEligibleAt)}` : "");
    node.append(create("span", "status-dot"));
    const copy = create("span");
    copy.append(create("span", "operation-label", ["stale", "unhealthy"].includes(health) && operation?.error?.code ? operation.error.code.replaceAll("_", " ") : label));
    const time = attemptTime(operation);
    const detail = forcedRunning || health === "running" ? "running" : health === "disabled" ? "disabled" : relativeTime(time);
    copy.append(create("span", "operation-detail", ` · ${detail}`));
    node.append(copy);
    return node;
  }

  function button(label, className, onClick, disabled, title) {
    const node = create("button", className, label);
    node.type = "button";
    node.disabled = Boolean(disabled);
    if (title) node.title = title;
    node.addEventListener("click", onClick);
    return node;
  }

  function renderAccount(account) {
    const usagePoll = account.usage || {};
    const identity = identityFor(account);
    const heartbeatGroups = heartbeatGroupsFor(account);
    const heartbeatJobs = heartbeatGroups.flat();
    const pendingPoll = state.pendingAccounts.has(account.id) || usagePoll.inFlight || healthOf(usagePoll) === "running";
    const hasHeartbeatRunning = heartbeatJobs.some((job) => state.pendingHeartbeats.has(job.id) || job.inFlight || healthOf(job) === "running");
    const accountHealth = identity.match === false ? "unhealthy" : healthOf(usagePoll);
    const provider = providerPresentation(account.provider);
    const card = create("article", `account-card ${accountHealth}`);
    card.setAttribute("aria-labelledby", `account-${account.id}`);

    const identityRow = create("div", "identity");
    const icon = create("div", `provider-icon ${provider.className}`, provider.initial);
    icon.setAttribute("aria-hidden", "true");
    identityRow.append(icon);
    const copy = create("div", "identity-copy");
    copy.append(create("div", "account-name", account.label || `${provider.label} account`));
    copy.firstChild.id = `account-${account.id}`;
    const meta = create("div", "account-meta");
    const symbol = create("span", `identity-symbol ${identity.match === false ? "mismatch" : identity.match === null ? "unknown" : ""}`, identity.match === true ? "✓" : identity.match === false ? "!" : "·");
    symbol.setAttribute("aria-label", identity.match === true ? "Identity matches" : identity.match === false ? "Identity mismatch" : "Identity not checked");
    meta.append(symbol, create("span", "account-meta-text", identity.details));
    copy.append(meta);
    identityRow.append(copy);
    card.append(identityRow);

    if (identity.match === false) {
      const expected = identity.expected.email || identity.expected.accountId || "configured identity";
      card.append(create("div", "mismatch-note", `Identity mismatch · expected ${expected}. Heartbeats are blocked.`));
    }

    const metrics = create("div", "metrics");
    const availableMetrics = [...windowsFor(account), ...balancesFor(account)];
    if (availableMetrics.length) availableMetrics.forEach((metric) => metrics.append(renderMetric(account.id, metric)));
    else metrics.append(create("div", "empty-metrics", pendingPoll ? "Checking provider usage…" : "Usage unavailable — check this account"));
    card.append(metrics);

    const footer = create("div", "card-footer");
    const operations = create("div", "operations");
    operations.append(operationNode("Poll", usagePoll, pendingPoll));
    if (heartbeatGroups.length) {
      heartbeatGroups.forEach((group) => operations.append(operationNode("Heartbeat", combinedHeartbeat(group), group.some((job) => state.pendingHeartbeats.has(job.id)))));
    } else {
      operations.append(operationNode("No heartbeat", { enabled: false }, false));
    }
    footer.append(operations);

    const actions = create("div", "card-actions");
    actions.append(button(
      pendingPoll ? "Checking…" : "Check usage",
      "action-button",
      () => runAction(`/api/accounts/${encodeURIComponent(account.id)}/check`, `Checking ${account.label || provider.label}`, state.pendingAccounts, account.id),
      pendingPoll,
    ));
    heartbeatGroups.forEach((group) => {
      const job = group.find((candidate) => candidate.enabled) || group[0];
      const running = group.some((candidate) => state.pendingHeartbeats.has(candidate.id) || candidate.inFlight || healthOf(candidate) === "running");
      const blocked = group.every((candidate) => candidate.enabled === false) || identity.match === false;
      actions.append(button(
        running ? "Running…" : "Heartbeat",
        "action-button heartbeat",
        () => runAction(`/api/heartbeats/${encodeURIComponent(job.id)}/run`, `Running ${job.label || "heartbeat"}`, state.pendingHeartbeats, job.id),
        running || blocked || hasHeartbeatRunning,
        blocked ? identity.match === false ? "Blocked by identity mismatch" : "Heartbeat disabled" : undefined,
      ));
    });
    footer.append(actions);
    card.append(footer);
    return card;
  }

  function render() {
    if (!state.status) return;
    const accounts = asArray(state.status.accounts);
    elements.accounts.replaceChildren();
    if (!accounts.length) elements.accounts.append(create("div", "empty-state", "No provider accounts are configured."));
    else accounts.forEach((account) => elements.accounts.append(renderAccount(account)));
    elements.accounts.setAttribute("aria-busy", "false");

    const health = healthOf(state.status.health || state.status.overallHealth);
    elements.overallHealth.className = `health-pill ${health}`;
    elements.overallHealth.lastElementChild.textContent = health === "healthy" ? "All healthy" : health.charAt(0).toUpperCase() + health.slice(1);
    const generatedAt = state.status.generatedAt || state.status.observedAt;
    elements.updated.textContent = generatedAt ? `Status updated ${relativeTime(generatedAt)}` : "Current in-memory status";

    const anyPollRunning = accounts.some((account) => healthOf(account.usage) === "running");
    const allHeartbeats = asArray(state.status.heartbeats);
    const enabledHeartbeats = allHeartbeats.filter((job) => job.enabled);
    elements.checkAll.disabled = state.pendingBulk.has("check") || anyPollRunning;
    elements.checkAll.textContent = state.pendingBulk.has("check") ? "Checking…" : "Check all";
    elements.heartbeatAll.disabled = state.pendingBulk.has("heartbeat") || enabledHeartbeats.length === 0 || enabledHeartbeats.some((job) => job.inFlight || healthOf(job) === "running");
    elements.heartbeatAll.textContent = state.pendingBulk.has("heartbeat") ? "Running…" : "Heartbeat all";
  }

  function showSkeleton() {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 4; index += 1) {
      const card = create("div", "account-card skeleton-card");
      card.append(create("div", "skeleton-line"), create("div", "skeleton-line short"), create("div", "skeleton-block"));
      fragment.append(card);
    }
    elements.accounts.replaceChildren(fragment);
  }

  function showNotice(message) {
    elements.notice.textContent = message || "";
    elements.notice.hidden = !message;
  }

  async function fetchStatus(options) {
    if (state.fetching) return;
    state.fetching = true;
    try {
      const response = await fetch("/api/status", { headers: { accept: "application/json" }, cache: "no-store" });
      if (!response.ok) throw new Error(`Status request failed (${response.status})`);
      state.status = await response.json();
      const accounts = asArray(state.status.accounts);
      const heartbeats = asArray(state.status.heartbeats);
      for (const accountId of state.pendingAccounts) {
        const account = accounts.find((item) => item.id === accountId);
        if (account && !account.usage?.inFlight) state.pendingAccounts.delete(accountId);
      }
      for (const heartbeatId of state.pendingHeartbeats) {
        const heartbeat = heartbeats.find((item) => item.id === heartbeatId);
        if (heartbeat && !heartbeat.inFlight) state.pendingHeartbeats.delete(heartbeatId);
      }
      if (!accounts.some((account) => account.usage?.inFlight)) state.pendingBulk.delete("check");
      if (!heartbeats.some((heartbeat) => heartbeat.inFlight)) state.pendingBulk.delete("heartbeat");
      elements.apiState.textContent = "API connected";
      showNotice("");
      render();
    } catch (error) {
      elements.apiState.textContent = "API unavailable";
      showNotice(error instanceof Error ? error.message : "Could not load provider status.");
      if (!state.status) {
        elements.accounts.setAttribute("aria-busy", "false");
        elements.accounts.replaceChildren(create("div", "empty-state", "Provider status is unavailable. The page will retry automatically."));
      }
    } finally {
      state.fetching = false;
      if (options?.announce) elements.announcer.textContent = "Provider status refreshed";
    }
  }

  async function runAction(path, announcement, pendingSet, pendingKey) {
    if (pendingSet.has(pendingKey)) return;
    pendingSet.add(pendingKey);
    showNotice("");
    elements.announcer.textContent = announcement;
    render();
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { accept: "application/json", "x-provider-pulse-action": "1" },
      });
      if (!response.ok) {
        let detail = "";
        try {
          const body = await response.json();
          detail = body.error?.message || body.message || "";
        } catch (_) { /* Response may not be JSON. */ }
        throw new Error(detail || `Action failed (${response.status})`);
      }
      const receipt = await response.json();
      const receiptId = receipt.operationId || receipt.receipts?.[0]?.operationId;
      elements.apiState.textContent = receiptId ? `Queued · ${receiptId}` : "Action queued";
      elements.announcer.textContent = `${announcement} started`;
      window.setTimeout(() => fetchStatus(), ACTION_REFRESH_MS);
    } catch (error) {
      pendingSet.delete(pendingKey);
      showNotice(error instanceof Error ? error.message : "Could not start action.");
      elements.announcer.textContent = "Action failed";
      render();
    }
  }

  elements.checkAll.addEventListener("click", () => runAction("/api/check-all", "Checking all accounts", state.pendingBulk, "check"));
  elements.heartbeatAll.addEventListener("click", () => runAction("/api/heartbeat-all", "Running all enabled heartbeats", state.pendingBulk, "heartbeat"));

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) fetchStatus();
  });

  showSkeleton();
  fetchStatus();
  window.setInterval(() => {
    if (!document.hidden) fetchStatus();
  }, POLL_INTERVAL_MS);
})();
