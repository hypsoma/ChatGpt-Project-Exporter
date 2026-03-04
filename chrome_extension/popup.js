const dateFromEl = document.getElementById("dateFrom");
const dateToEl = document.getElementById("dateTo");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const zipBtn = document.getElementById("zipBtn");
const clearBtn = document.getElementById("clearBtn");
const debugBtn = document.getElementById("debugBtn");
const statusTextEl = document.getElementById("statusText");
const statDiscovered = document.getElementById("statDiscovered");
const statExported = document.getElementById("statExported");
const statFailed = document.getElementById("statFailed");
const activeContext = document.getElementById("activeContext");
const activeSource = document.getElementById("activeSource");
const projectsEl = document.getElementById("projects");
const loader = document.getElementById("loader");
let clearConfirmArmedUntil = 0;
let clearButtonResetTimer = null;

function setNodeText(node, text) {
  if (!node) return;
  node.textContent = text;
}

function resetUiToIdle(statusText = "Idle") {
  statusTextEl.textContent = statusText;
  activeContext.textContent = "-";
  statDiscovered.textContent = 0;
  statExported.textContent = 0;
  statFailed.textContent = 0;
  projectsEl.textContent = "No local export data";
  setBusy(false);
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(response);
    });
  });
}

function getDateFilter() {
  const from = dateFromEl.value || "";
  const to = dateToEl.value || "";

  if (from && to) {
    if (from > to) return { error: "Start date must be earlier than end date" };
    return { mode: "between", from, to };
  }
  if (from) return { mode: "after", from };
  if (to) return { mode: "before", before: to };
  return { mode: "all" };
}

function setBusy(busy) {
  startBtn.disabled = busy;
  zipBtn.disabled = busy;
  clearBtn.disabled = busy;

  if (busy) {
    loader.classList.remove("hidden");
    stopBtn.disabled = false;
  } else {
    loader.classList.add("hidden");
    stopBtn.disabled = true;
  }
}

function renderStatus(payload) {
  try {
    if (!payload?.ok) {
      statusTextEl.textContent = "Offline";
      return;
    }

    const status = payload.status || {};
    const totals = status.totals || {};
    const index = payload.index || { projects: {} };

    statusTextEl.textContent = status.progressText || "Idle";
    statDiscovered.textContent = totals.discovered || 0;
    statExported.textContent = totals.exported || 0;
    statFailed.textContent = totals.failed || 0;

    const ctx = [];
    if (status.activeProject) ctx.push(String(status.activeProject));
    if (status.activeConversation) {
      if (status.activeConversationTitle) {
        const title = String(status.activeConversationTitle);
        ctx.push(title.length > 25 ? title.slice(0, 25) + '...' : title);
      } else {
        ctx.push(String(status.activeConversation).slice(0, 8));
      }
    }
    activeContext.textContent = ctx.length ? ctx.join(" / ") : "-";

    const projectLines = [];
    for (const p of Object.values(index.projects || {})) {
      if (!p || typeof p !== "object") continue;
      projectLines.push(`${p.name || p.key}: ${p.conversations?.length || 0} exported`);
    }
    projectsEl.textContent = projectLines.length ? projectLines.join("\n") : "No local export data";

    setBusy(Boolean(status.running));
  } catch (_err) {
    resetUiToIdle("Idle");
  }
}

async function loadLastSettings() {
  try {
    const response = await sendMessage({ type: "LOAD_LAST_SETTINGS" });
    if (!response?.ok || !response.settings) return;
    const dateFilter = response.settings.date_filter || { mode: "all" };
    dateFromEl.value = dateFilter.from || "";
    dateToEl.value = dateFilter.to || dateFilter.before || "";
  } catch (_err) { }
}

async function refreshStatus() {
  try {
    const response = await sendMessage({ type: "GET_STATUS" });
    renderStatus(response);
  } catch (_err) {
    resetUiToIdle("Disconnected");
  }
}

async function refreshActiveSource() {
  try {
    const response = await sendMessage({ type: "GET_ACTIVE_CHATGPT_TAB_CONTEXT" });
    if (!response?.ok) {
      setNodeText(activeSource, "Open a ChatGPT page first");
      return;
    }
    setNodeText(activeSource, response.displayText || response.url || "ChatGPT page");
  } catch (_err) {
    setNodeText(activeSource, "Unavailable");
  }
}

startBtn.addEventListener("click", async () => {
  try {
    const dateFilter = getDateFilter();
    if (dateFilter.error) {
      statusTextEl.textContent = dateFilter.error;
      return;
    }

    const response = await sendMessage({
      type: "START_EXPORT_ACTIVE_TAB",
      options: {
        maxProjectScrolls: 120,
        scrollDelayMs: 900,
        extractDelayMs: 300,
        extractTimeoutMs: 45000,
        dateFilter
      },
      settings: {
        date_filter: dateFilter
      }
    });

    if (!response?.ok) {
      statusTextEl.textContent = `Error: ${response?.error || "unknown"}`;
    }
  } catch (err) {
    statusTextEl.textContent = `Error: ${err.message}`;
  }
});

stopBtn.addEventListener("click", async () => {
  try {
    await sendMessage({ type: "STOP_EXPORT" });
  } catch (_err) { }
});

zipBtn.addEventListener("click", async () => {
  try {
    const response = await sendMessage({ type: "EXPORT_ZIP" });
    if (!response?.ok) {
      alert(`Export failed: ${response?.error}`);
    }
  } catch (err) {
    alert(`Export error: ${err.message}`);
  }
});

clearBtn.addEventListener("click", async () => {
  const now = Date.now();
  if (now > clearConfirmArmedUntil) {
    clearConfirmArmedUntil = now + 3500;
    clearBtn.textContent = "Confirm Clear";
    statusTextEl.textContent = "Click Clear again to confirm";
    if (clearButtonResetTimer) {
      clearTimeout(clearButtonResetTimer);
    }
    clearButtonResetTimer = setTimeout(() => {
      clearBtn.textContent = "Clear Data";
      clearConfirmArmedUntil = 0;
    }, 3600);
    return;
  }

  try {
    setBusy(true);
    const response = await sendMessage({ type: "CLEAR_DATA" });
    if (!response?.ok) {
      throw new Error(response?.error || "clear_failed");
    }
    clearBtn.textContent = "Clear Data";
    clearConfirmArmedUntil = 0;
    resetUiToIdle("Idle");
    await refreshStatus();
    setTimeout(() => window.close(), 120);
  } catch (err) {
    clearBtn.textContent = "Clear Data";
    clearConfirmArmedUntil = 0;
    resetUiToIdle("Clear failed");
    statusTextEl.textContent = `Clear failed: ${err.message}`;
  }
});

debugBtn.addEventListener("click", async () => {
  try {
    statusTextEl.textContent = "Generating debug log file...";
    const response = await sendMessage({ type: "EXPORT_DEBUG_LOG" });
    if (!response?.ok) {
      throw new Error(response?.error || "debug_export_failed");
    }
    statusTextEl.textContent = "Debug log downloaded";
  } catch (err) {
    statusTextEl.textContent = `Debug failed: ${err.message}`;
  } finally {
    refreshStatus();
  }
});

window.addEventListener("error", () => {
  resetUiToIdle("Idle");
});

window.addEventListener("unhandledrejection", () => {
  resetUiToIdle("Idle");
});

const manifest = chrome.runtime.getManifest();
const versionTextEl = document.getElementById("versionText");
if (versionTextEl) {
  versionTextEl.textContent = `Version ${manifest.version}`;
}

loadLastSettings()
  .then(() => Promise.all([refreshActiveSource(), refreshStatus()]))
  .catch(() => resetUiToIdle("Idle"));

const statusTimer = setInterval(() => {
  Promise.all([refreshStatus(), refreshActiveSource()]).catch(() => resetUiToIdle("Disconnected"));
}, 1500);

window.addEventListener("unload", () => {
  clearInterval(statusTimer);
  if (clearButtonResetTimer) {
    clearTimeout(clearButtonResetTimer);
  }
});
