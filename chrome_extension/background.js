import { createZip } from "./zip.js";

const INDEX_KEY = "export_index_v2";
const SETTINGS_KEY = "export_settings_v2";

const runtimeState = {
    running: false,
    cancelRequested: false,
    progressText: "Idle",
    activeProject: "",
    activeConversation: "",
    activeConversationTitle: "",
    totals: {
        projects: 0,
        discovered: 0,
        exported: 0,
        skipped: 0,
        failed: 0
    }
};

const TEMP_LOG_LIMIT = 5000;
const tempLogs = [];
const DEBUG_ARTIFACT_LIMIT = 100;
const debugArtifacts = [];
const INDEX_FLUSH_BATCH_SIZE = 10;

let exportIndexCache = null;

function sanitizeLogDetails(details) {
    if (details === null || details === undefined) return null;
    try {
        return JSON.parse(JSON.stringify(details));
    } catch {
        return String(details);
    }
}

function pushTempLog(source, event, details = null) {
    const entry = {
        at: nowIso(),
        source,
        event,
        details: sanitizeLogDetails(details)
    };
    tempLogs.push(entry);
    if (tempLogs.length > TEMP_LOG_LIMIT) {
        tempLogs.shift();
    }
}

function pushDebugArtifact(name, content) {
    debugArtifacts.push({
        at: nowIso(),
        name: String(name || "artifact"),
        content: String(content || "")
    });
    if (debugArtifacts.length > DEBUG_ARTIFACT_LIMIT) {
        debugArtifacts.splice(0, debugArtifacts.length - DEBUG_ARTIFACT_LIMIT);
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage || "operation_timeout")), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

function nowIso() {
    return new Date().toISOString();
}

function slugify(value) {
    if (!value) return "";
    const cleaned = String(value)
        .trim()
        .replace(/[\\/:*?"<>|]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .toLowerCase();
    return cleaned || "";
}

function normalizeArchiveName(value, fallback = "item", maxLength = 80) {
    const slug = slugify(value);
    if (!slug) return fallback;
    const truncated = slug.slice(0, maxLength).replace(/-+$/g, "");
    return truncated || fallback;
}

function makeUniqueName(baseName, usedNames) {
    const normalized = normalizeArchiveName(baseName);
    if (!usedNames.has(normalized)) {
        usedNames.add(normalized);
        return normalized;
    }

    let suffix = 2;
    while (usedNames.has(`${normalized}-${suffix}`)) {
        suffix += 1;
    }
    const unique = `${normalized}-${suffix}`;
    usedNames.add(unique);
    return unique;
}

async function downloadBlobFile(filename, mimeType, payloadBytes) {
    let binary = "";
    const bytes = payloadBytes instanceof Uint8Array ? payloadBytes : new Uint8Array(payloadBytes);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    const dataUrl = `data:${mimeType};base64,${btoa(binary)}`;
    await withCallback((cb) => chrome.downloads.download({ url: dataUrl, filename, saveAs: true }, cb));
}

function parseProjectFromUrl(urlText) {
    try {
        const u = new URL(urlText);
        const qProject = u.searchParams.get("project");
        const parts = u.pathname.split("/").filter(Boolean);

        if (qProject) {
            return { key: qProject, name: qProject, url: u.toString() };
        }

        if (parts[0] === "g" && parts[1]) {
            const gId = parts[1];
            const gProjectMatch = /^g-p-([0-9a-f]{32})(?:-(.+))?$/i.exec(gId);
            if (gProjectMatch) {
                const normalizedProjectKey = gId.toLowerCase();
                const namePart = gProjectMatch[2] || normalizedProjectKey;
                return { key: normalizedProjectKey, name: slugify(namePart) || normalizedProjectKey, url: u.toString() };
            }
            const fallbackName = slugify(gId) || gId;
            return { key: gId, name: fallbackName, url: u.toString() };
        }

        if (parts[0] === "project" && parts[1]) {
            const key = parts[1];
            return { key, name: key, url: u.toString() };
        }

        const hostName = u.hostname.replace("www.", "").replace(".com", "");
        return { key: "default", name: hostName || "chatgpt", url: u.toString() };
    } catch {
        return null;
    }
}

function getSourceScopeFromUrl(url) {
    const text = String(url || "");
    try {
        const u = new URL(text, "https://chatgpt.com");
        const pathname = u.pathname;
        if (pathname.startsWith("/g/")) return "project";
        if (pathname.startsWith("/c/")) return "global";
        return "";
    } catch {
        return "";
    }
}

function parseTimestampMs(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) return null;
        return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
    }
    const text = String(value).trim();
    if (!text) return null;
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? null : parsed;
}

function parseDateBoundaryStart(dateText) {
    if (!dateText) return null;
    const ms = Date.parse(`${dateText}T00:00:00`);
    return Number.isNaN(ms) ? null : ms;
}

function parseDateBoundaryEnd(dateText) {
    if (!dateText) return null;
    const ms = Date.parse(`${dateText}T23:59:59.999`);
    return Number.isNaN(ms) ? null : ms;
}

function filterConversationListings(rawItems, dateFilter) {
    const normalized = rawItems.filter((item) => item.conversation_id && item.url);
    const mode = dateFilter?.mode || "all";
    if (mode === "all") return normalized;

    const beforeEnd = parseDateBoundaryEnd(dateFilter?.before);
    const fromStart = parseDateBoundaryStart(dateFilter?.from);
    const toEnd = parseDateBoundaryEnd(dateFilter?.to);

    return normalized.filter((item) => {
        const updatedAtMs = parseTimestampMs(item.updated_at || item.created_at);
        if (!updatedAtMs) return true;
        if (mode === "before") return beforeEnd !== null ? updatedAtMs <= beforeEnd : true;
        if (mode === "after") return fromStart !== null ? updatedAtMs >= fromStart : true;
        if (mode === "between") {
            const lowerOk = fromStart !== null ? updatedAtMs >= fromStart : true;
            const upperOk = toEnd !== null ? updatedAtMs <= toEnd : true;
            return lowerOk && upperOk;
        }
        return true;
    });
}

function isProjectScopeItem(item) {
    const directScope = String(item?.source_scope || "").trim();
    if (directScope === "project") return true;
    if (directScope === "global") return false;
    return getSourceScopeFromUrl(item?.url || "") === "project";
}

function getConversationTimeMs(conversation) {
    if (!conversation || !Array.isArray(conversation.messages)) return null;
    let latest = null;
    for (const msg of conversation.messages) {
        const ms = parseTimestampMs(msg?.timestamp);
        if (ms === null) continue;
        if (latest === null || ms > latest) latest = ms;
    }
    return latest;
}

function isConversationInDateFilter(conversation, dateFilter) {
    const mode = dateFilter?.mode || "all";
    if (mode === "all") return true;
    const convMs = getConversationTimeMs(conversation);
    if (convMs === null) return true;

    const beforeEnd = parseDateBoundaryEnd(dateFilter?.before);
    const fromStart = parseDateBoundaryStart(dateFilter?.from);
    const toEnd = parseDateBoundaryEnd(dateFilter?.to);

    if (mode === "before") return beforeEnd !== null ? convMs <= beforeEnd : true;
    if (mode === "after") return fromStart !== null ? convMs >= fromStart : true;
    if (mode === "between") {
        const lowerOk = fromStart !== null ? convMs >= fromStart : true;
        const upperOk = toEnd !== null ? convMs <= toEnd : true;
        return lowerOk && upperOk;
    }
    return true;
}

function withCallback(apiCall) {
    return new Promise((resolve, reject) => {
        try {
            apiCall((result) => {
                const err = chrome.runtime.lastError;
                if (err) { reject(new Error(err.message)); return; }
                resolve(result);
            });
        } catch (e) { reject(e); }
    });
}

async function storageGet(keys) { return await withCallback((cb) => chrome.storage.local.get(keys, cb)); }
async function storageSet(payload) { return await withCallback((cb) => chrome.storage.local.set(payload, cb)); }
async function storageRemove(keys) { return await withCallback((cb) => chrome.storage.local.remove(keys, cb)); }

async function loadIndex() {
    if (exportIndexCache) return exportIndexCache;
    const data = await storageGet(INDEX_KEY);
    exportIndexCache = data[INDEX_KEY] || { projects: {} };
    return exportIndexCache;
}

async function saveIndex(index) {
    exportIndexCache = index;
    await storageSet({ [INDEX_KEY]: index });
}

async function ensureProjectEntry(project) {
    const index = await loadIndex();
    if (!index.projects[project.key]) {
        index.projects[project.key] = {
            key: project.key,
            name: project.name,
            url: project.url,
            conversations: [],
            updated_at: nowIso()
        };
        await saveIndex(index);
    }
    return index.projects[project.key];
}

async function markConversationSaved(project, conversation) {
    const convKey = `conv:${project.key}:${conversation.conversation_id}`;
    const index = await loadIndex();
    const entry = index.projects[project.key] || {
        key: project.key,
        name: project.name,
        url: project.url,
        conversations: [],
        updated_at: nowIso()
    };
    if (!entry.conversations.includes(conversation.conversation_id)) {
        entry.conversations.push(conversation.conversation_id);
    }
    entry.updated_at = nowIso();
    index.projects[project.key] = entry;
    exportIndexCache = index;
    return { convKey, index };
}

async function flushStagedConversations(stagedConversations, index) {
    const keys = Object.keys(stagedConversations);
    if (!keys.length) return;
    await storageSet({ ...stagedConversations, [INDEX_KEY]: index });
    for (const key of keys) {
        delete stagedConversations[key];
    }
}

async function clearAllData() {
    const index = await loadIndex();
    const removeKeys = [INDEX_KEY, SETTINGS_KEY];
    for (const project of Object.values(index.projects || {})) {
        for (const conversationId of project.conversations || []) {
            removeKeys.push(`conv:${project.key}:${conversationId}`);
        }
    }
    exportIndexCache = { projects: {} };
    await storageRemove(removeKeys);
    await saveIndex(exportIndexCache);
    resetRuntimeTotals();
}

function normalizeMarkdownForTemplate(rawContent) {
    const content = String(rawContent || "").replace(/\r\n/g, "\n");
    if (!content.trim()) return "";

    const output = [];
    const lines = content.split("\n");
    for (const rawLine of lines) {
        const line = String(rawLine).replace(/ +$/, "");

        // Remove markdown horizontal rules.
        if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            continue;
        }

        const headingMatch = /^(\s{0,3})(#{1,6})\s+(.*)$/.exec(line);
        if (!headingMatch) {
            output.push(line);
            continue;
        }

        const indent = headingMatch[1] || "";
        const level = headingMatch[2].length;
        const headingText = (headingMatch[3] || "").trim();
        const lowered = headingText.toLowerCase();

        if (lowered === "assistant") {
            continue;
        }
        if (lowered === "user") {
            output.push(`${indent}## abstract`);
            continue;
        }

        const promotedLevel = Math.max(1, level - 1);
        output.push(`${indent}${"#".repeat(promotedLevel)} ${headingText}`);
    }

    return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function demoteMarkdownHeadingLevel(rawContent, levels = 1) {
    const shift = Math.max(0, Number(levels) || 0);
    if (!shift) return String(rawContent || "");

    return String(rawContent || "").split("\n").map((rawLine) => {
        const line = String(rawLine).replace(/ +$/, "");
        const match = /^(\s{0,3})(#{1,6})\s+(.*)$/.exec(line);
        if (!match) return line;
        const indent = match[1] || "";
        const currentLevel = match[2].length;
        const text = match[3] || "";
        const nextLevel = Math.min(6, currentLevel + shift);
        return `${indent}${"#".repeat(nextLevel)} ${text}`;
    }).join("\n");
}

function buildMarkdown(conversation) {
    const lines = [`# ${conversation.conversation_title || "Untitled"}`, ""];
    for (const msg of conversation.messages || []) {
        const content = normalizeMarkdownForTemplate(msg.content || "");
        if (!content) continue;

        const role = String(msg.role || "").toLowerCase();
        if (role === "user") {
            const demotedContent = demoteMarkdownHeadingLevel(content, 1);
            lines.push(`## abstract\n\n${demotedContent}\n`);
            continue;
        }

        lines.push(`${content}\n`);
    }
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

async function sendMessageToTab(tabId, message) {
    try {
        const response = await withCallback((cb) => chrome.tabs.sendMessage(tabId, message, cb));
        if (response) return response;
    } catch (_err) {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
        await sleep(1000);
        return await withCallback((cb) => chrome.tabs.sendMessage(tabId, message, cb));
    }
    throw new Error("content_script_unavailable");
}

async function getActiveChatgptTabContext() {
    const tabs = await withCallback((cb) => chrome.tabs.query({ active: true, lastFocusedWindow: true }, cb));
    const activeTab = tabs?.[0];
    if (!activeTab?.id || !activeTab.url) {
        throw new Error("no_active_tab");
    }

    let parsed;
    try {
        parsed = new URL(activeTab.url);
    } catch {
        throw new Error("active_tab_url_invalid");
    }

    if (parsed.hostname !== "chatgpt.com") {
        throw new Error("active_tab_not_chatgpt");
    }

    const project = parseProjectFromUrl(activeTab.url);
    if (!project) {
        throw new Error("active_tab_not_supported_page");
    }

    try {
        const domResponse = await sendMessageToTab(activeTab.id, { type: "GET_DOM_PROJECT_TITLE" });
        if (domResponse?.ok && domResponse.title) {
            project.name = domResponse.title;
        }
    } catch (_err) {
        // Fallback to URL-based name if content script can't provide the DOM title
    }

    return {
        tabId: activeTab.id,
        url: activeTab.url,
        project,
        displayText: project.name || project.key || parsed.pathname
    };
}

async function runExport(projectInputs, options = {}) {
    tempLogs.length = 0;
    debugArtifacts.length = 0;
    pushTempLog("background", "export_start", { projectInputs, options });
    const projects = projectInputs.map(input => {
        if (typeof input === "string") return parseProjectFromUrl(input);
        return input;
    }).filter(Boolean);
    if (!projects.length) {
        runtimeState.running = false;
        runtimeState.progressText = "No valid projects";
        return;
    }

    runtimeState.running = true;
    runtimeState.cancelRequested = false;
    runtimeState.activeConversation = "";
    runtimeState.activeConversationTitle = "";
    runtimeState.totals = { projects: projects.length, discovered: 0, exported: 0, skipped: 0, failed: 0 };

    let tabId = null;
    let initialActiveTabId = null;
    const preferredTabId = Number.isFinite(options.preferredTabId) ? options.preferredTabId : null;
    const keepPreferredTabOpen = Boolean(options.keepPreferredTabOpen);
    try {
        const activeTabs = await withCallback((cb) => chrome.tabs.query({ active: true, currentWindow: true }, cb));
        initialActiveTabId = activeTabs?.[0]?.id || null;

        if (preferredTabId) {
            tabId = preferredTabId;
            await sleep(1200);
        } else {
            const tab = await withCallback((cb) => chrome.tabs.create({ url: projects[0].url, active: false }, cb));
            tabId = tab.id;
            await sleep(4000);
        }

        for (const project of projects) {
            if (runtimeState.cancelRequested) break;
            runtimeState.activeProject = project.name;
            runtimeState.progressText = `Scanning: ${project.name}`;

            await ensureProjectEntry(project);
            if (!preferredTabId || projects.length > 1) {
                await withCallback((cb) => chrome.tabs.update(tabId, { url: project.url, active: false }, cb));
                await sleep(3500);
            }

            // [MOD] Pass options to content script to enable scrolling configuration
            const listResponse = await sendMessageToTab(tabId, { type: "COLLECT_CONVERSATIONS", options });
            const discoveredAll = filterConversationListings(listResponse?.links || [], options.dateFilter || { mode: "all" });
            const discovered = discoveredAll.filter((item) => isProjectScopeItem(item));
            runtimeState.totals.discovered += discovered.length;
            pushTempLog("background", "discovery_summary", {
                count_project: discovered.length,
                count_total: discoveredAll.length
            });

            const index = await loadIndex();
            const doneSet = new Set(index.projects[project.key]?.conversations || []);
            const stagedConversations = {};
            let stagedCount = 0;

            for (const item of discovered) {
                if (runtimeState.cancelRequested) break;
                const convId = item.conversation_id;
                const sourceScope = item.source_scope || getSourceScopeFromUrl(item.url || "");

                pushTempLog("background", "item_eval", { convId, title: item.title, sourceScope });

                if (!convId || doneSet.has(convId)) {
                    if (doneSet.has(convId)) runtimeState.totals.skipped++;
                    continue;
                }

                runtimeState.activeConversation = convId;
                runtimeState.activeConversationTitle = "Extracting...";

                try {
                    pushTempLog("background", "extract_start", { convId });
                    const extractTimeoutMs = Number.isFinite(options.extractTimeoutMs) ? options.extractTimeoutMs : 45000;
                    const result = await withTimeout(
                        sendMessageToTab(tabId, { type: "EXTRACT_CONVERSATION", conversation_id: convId }),
                        extractTimeoutMs,
                        `extract_timeout_${convId}`
                    );
                    pushTempLog("background", "extract_result", { convId, ok: result?.ok });

                    if (result?.ok && result.conversation) {
                        const record = {
                            project_id: project.key,
                            project_name: project.name,
                            source_scope: sourceScope,
                            exported_at: nowIso(),
                            ...result.conversation
                        };
                        if (!isConversationInDateFilter(record, options.dateFilter || { mode: "all" })) {
                            runtimeState.totals.skipped++;
                            continue;
                        }
                        const { convKey } = await markConversationSaved(project, record);
                        stagedConversations[convKey] = record;
                        stagedCount += 1;
                        runtimeState.totals.exported++;
                        runtimeState.activeConversationTitle = normalizeArchiveName(result.conversation.conversation_title || item.title || "Untitled", "Untitled");
                        doneSet.add(convId);
                        if (stagedCount >= INDEX_FLUSH_BATCH_SIZE) {
                            await flushStagedConversations(stagedConversations, index);
                            stagedCount = 0;
                        }
                    } else {
                        runtimeState.totals.failed++;
                        runtimeState.activeConversationTitle = "Failed";
                    }
                } catch (err) {
                    runtimeState.totals.failed++;
                    runtimeState.activeConversationTitle = "Error";
                    pushTempLog("background", "extract_error", { convId, msg: err.message });
                }
                runtimeState.progressText = `Exported ${runtimeState.totals.exported}/${runtimeState.totals.discovered}`;
                await sleep(options.extractDelayMs || options.delayMs || 1500);
                runtimeState.activeConversation = "";
                runtimeState.activeConversationTitle = "";
            }
            await flushStagedConversations(stagedConversations, index);
        }
        runtimeState.progressText = runtimeState.cancelRequested ? "Stopped" : "Completed";
    } catch (err) {
        runtimeState.progressText = `Error: ${err.message}`;
    } finally {
        runtimeState.running = false;
        if (tabId) {
            if (!keepPreferredTabOpen) {
                if (initialActiveTabId) chrome.tabs.update(initialActiveTabId, { active: true }).catch(() => { });
                chrome.tabs.remove(tabId).catch(() => { });
            }
        }
    }
}

function resetRuntimeTotals() {
    runtimeState.totals = { projects: 0, discovered: 0, exported: 0, skipped: 0, failed: 0 };
    runtimeState.activeConversation = "";
    runtimeState.activeConversationTitle = "";
    runtimeState.progressText = "Idle";
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "GET_STATUS") {
        loadIndex().then(index => sendResponse({ ok: true, status: runtimeState, index }));
        return true;
    }
    if (message?.type === "APPEND_TEMP_LOG") {
        pushTempLog(message.source || "content", message.event || "unknown", message.details || null);
        sendResponse({ ok: true });
        return false;
    }
    if (message?.type === "GET_TEMP_LOGS") {
        sendResponse({ ok: true, logs: tempLogs });
        return false;
    }
    if (message?.type === "APPEND_DEBUG_ARTIFACT") {
        pushDebugArtifact(message.name || "artifact", message.content || "");
        sendResponse({ ok: true });
        return false;
    }
    if (message.type === "START_EXPORT_ASYNC") {
        if (message.settings) {
            storageSet({ [SETTINGS_KEY]: message.settings }).catch(() => { });
        }
        runExport(message.projectUrls, message.options).catch(e => console.error(e));
        sendResponse({ ok: true });
        return false;
    }
    if (message.type === "START_EXPORT_ACTIVE_TAB") {
        if (message.settings) {
            storageSet({ [SETTINGS_KEY]: message.settings }).catch(() => { });
        }
        getActiveChatgptTabContext()
            .then((ctx) => {
                runExport([ctx.project], {
                    ...(message.options || {}),
                    preferredTabId: ctx.tabId,
                    keepPreferredTabOpen: true
                }).catch((e) => console.error(e));
                sendResponse({ ok: true });
            })
            .catch((e) => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (message?.type === "GET_ACTIVE_CHATGPT_TAB_CONTEXT") {
        getActiveChatgptTabContext()
            .then((ctx) => sendResponse({ ok: true, url: ctx.url, displayText: ctx.displayText }))
            .catch((e) => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (message.type === "STOP_EXPORT") {
        runtimeState.cancelRequested = true;
        sendResponse({ ok: true });
        return false;
    }
    if (message.type === "CLEAR_DATA") {
        clearAllData().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (message.type === "EXPORT_ZIP") {
        exportAsZip().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
    if (message?.type === "LOAD_LAST_SETTINGS") {
        storageGet(SETTINGS_KEY).then(data => sendResponse({ ok: true, settings: data[SETTINGS_KEY] || null }));
        return true;
    }
    if (message?.type === "EXPORT_DEBUG_LOG") {
        exportDebugLogFile().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: e?.message }));
        return true;
    }
});

async function exportAsZip() {
    const index = await loadIndex();
    const files = [];
    for (const project of Object.values(index.projects || {})) {
        const usedNames = new Set();
        const folder = makeUniqueName(project.name || project.key, new Set());
        const conversationIds = project.conversations || [];
        const convKeys = conversationIds.map((id) => `conv:${project.key}:${id}`);
        const convStore = convKeys.length ? await storageGet(convKeys) : {};
        for (const id of conversationIds) {
            const conv = convStore[`conv:${project.key}:${id}`];
            if (!conv) continue;
            const scope = conv.source_scope || getSourceScopeFromUrl(conv.url || "");
            if (scope !== "project") continue;
            const name = makeUniqueName(conv.conversation_title || "Untitled", usedNames);
            files.push({ name: `json/${folder}/${name}.json`, data: JSON.stringify(conv, null, 2) });
            files.push({ name: `md/${folder}/${name}.md`, data: buildMarkdown(conv) });
        }
    }
    if (!files.length) throw new Error("No data");
    const bytes = createZip(files);
    await downloadBlobFile(`export-${Date.now()}.zip`, "application/zip", bytes);
}

async function exportDebugLogFile() {
    const snapshot = { generated_at: nowIso(), runtime_state: runtimeState, temp_logs: tempLogs, debug_artifacts: debugArtifacts };
    const payload = new TextEncoder().encode(JSON.stringify(snapshot, null, 2));
    await downloadBlobFile(`debug-${Date.now()}.json`, "application/json", payload);
}
