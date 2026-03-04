function fullLog(event, details = null) {
  try {
    chrome.runtime.sendMessage(
      {
        type: "APPEND_TEMP_LOG",
        source: "content_dom",
        event,
        details: JSON.parse(JSON.stringify(details))
      },
      () => { }
    );
  } catch (_err) { }
}

function getProjectContext() {
  const url = new URL(window.location.href);
  const match = /^\/(g|project)\/([^/]+)/.exec(url.pathname);
  if (!match) return { isProject: false, projectId: "" };
  return {
    isProject: true,
    projectId: match[2],
    projectPathType: match[1]
  };
}

function normalizeProjectId(rawProjectId) {
  return String(rawProjectId || "").trim().toLowerCase();
}

function tryParseConversationPath(pathname) {
  const projectConversation = /^\/(g|project)\/([^/]+)\/c\/([^/]+)/.exec(pathname);
  if (projectConversation) {
    return {
      conversationId: projectConversation[3],
      sourceScope: "project",
      sourceProjectId: projectConversation[2]
    };
  }

  const globalConversation = /^\/c\/([^/]+)/.exec(pathname);
  if (globalConversation) {
    return {
      conversationId: globalConversation[1],
      sourceScope: "global",
      sourceProjectId: ""
    };
  }

  return null;
}

function resolveConversationMeta(rawHref, context) {
  if (!rawHref) return null;

  try {
    const url = new URL(rawHref, window.location.origin);
    const parsed = tryParseConversationPath(url.pathname);
    if (!parsed) return null;

    return {
      url: url.toString(),
      conversation_id: parsed.conversationId,
      source_scope: parsed.sourceScope,
      source_project_id:
        parsed.sourceScope === "project"
          ? normalizeProjectId(parsed.sourceProjectId || context.projectId)
          : ""
    };
  } catch {
    return null;
  }
}

function normalizeTitle(rawTitle) {
  const clean = String(rawTitle || "").replace(/\s+/g, " ").trim();
  return clean || "Untitled";
}

function pickTitleFromAnchor(anchorNode) {
  const byTitleAttr = normalizeTitle(anchorNode.getAttribute("title"));
  if (byTitleAttr !== "Untitled") return byTitleAttr;

  const truncateNode = anchorNode.querySelector(".truncate");
  if (truncateNode) {
    const byTruncateNode = normalizeTitle(truncateNode.textContent);
    if (byTruncateNode !== "Untitled") return byTruncateNode;
  }

  return normalizeTitle(anchorNode.textContent);
}

const CONVERSATION_LINK_SELECTORS = [
  'a[data-sidebar-item="true"][href]',
  'aside a[href*="/c/"]',
  'nav a[href*="/c/"]',
  'a[href^="/c/"]',
  'a[href*="/g/"][href*="/c/"]',
  'a[href*="/project/"][href*="/c/"]'
].join(", ");

function collectLinksFromDocument(doc, context, sourceTag) {
  const candidates = doc.querySelectorAll(CONVERSATION_LINK_SELECTORS);
  const items = [];

  for (const anchor of candidates) {
    const href = anchor.getAttribute("href");
    const meta = resolveConversationMeta(href, context);
    if (!meta) continue;

    items.push({
      ...meta,
      title: pickTitleFromAnchor(anchor),
      source: sourceTag
    });
  }

  return items;
}

function extractLinksFromHtmlSnapshot(htmlText, context) {
  const parser = new DOMParser();
  const snapshotDocument = parser.parseFromString(htmlText, "text/html");
  return collectLinksFromDocument(snapshotDocument, context, "dom_html_snapshot");
}

function mergeConversationItems(targetMap, incomingItems) {
  for (const item of incomingItems) {
    const key = `${item.conversation_id}::${item.url}`;
    const existing = targetMap.get(key);
    if (!existing) {
      targetMap.set(key, item);
      continue;
    }

    if ((existing.title === "Untitled" || !existing.title) && item.title && item.title !== "Untitled") {
      targetMap.set(key, item);
    }
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scrollAllContainersTo(position) {
  const elements = document.querySelectorAll('div, nav, aside, main, section, ul');
  for (const el of elements) {
    if (el.scrollHeight > el.clientHeight) {
      const style = window.getComputedStyle(el);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'overlay') {
        el.scrollTop = position === "bottom" ? el.scrollHeight : 0;
      }
    }
  }
  if (position === "bottom") {
    window.scrollTo(0, document.body.scrollHeight);
  } else {
    window.scrollTo(0, 0);
  }
}

async function preloadSidebarHistory(context, options = {}) {
  const maxScrolls = Number.isFinite(options.maxProjectScrolls) ? options.maxProjectScrolls : 35;
  const delayMs =
    Number.isFinite(options.scrollDelayMs)
      ? options.scrollDelayMs
      : (Number.isFinite(options.delayMs) ? options.delayMs : 1200);
  const stableRoundsLimit = Number.isFinite(options.stableRoundsLimit) ? options.stableRoundsLimit : 5;
  const collected = new Map();

  let stableRounds = 0;

  mergeConversationItems(collected, collectLinksFromDocument(document, context, "dom_live_snapshot"));
  fullLog("scroll_collect_round", { round: 0, collected: collected.size });

  for (let i = 0; i < maxScrolls; i += 1) {
    const beforeCount = collected.size;

    scrollAllContainersTo("bottom");
    await wait(delayMs);

    mergeConversationItems(collected, collectLinksFromDocument(document, context, "dom_live_snapshot"));

    const afterCount = collected.size;
    const growth = afterCount - beforeCount;
    fullLog("scroll_collect_round", { round: i + 1, collected: afterCount, growth });

    if (growth <= 0) {
      stableRounds += 1;
      if (stableRounds >= stableRoundsLimit) break;
      continue;
    }

    stableRounds = 0;
  }

  scrollAllContainersTo("top");
  return Array.from(collected.values());
}

async function collectConversationLinks(options = {}) {
  const context = getProjectContext();
  fullLog("collect_start", {
    href: window.location.href,
    isProject: context.isProject,
    projectId: context.projectId
  });

  const incrementalLinks = await preloadSidebarHistory(context, options);
  const mergedLinks = new Map();
  mergeConversationItems(mergedLinks, incrementalLinks);

  const shouldUseHtmlSnapshot = Boolean(options.includeHtmlSnapshot) || mergedLinks.size === 0;
  if (shouldUseHtmlSnapshot) {
    const htmlSnapshot = document.documentElement.outerHTML;
    mergeConversationItems(mergedLinks, extractLinksFromHtmlSnapshot(htmlSnapshot, context));
  }
  const links = Array.from(mergedLinks.values());

  fullLog("collect_done", {
    discovered: links.length,
    sample: links.slice(0, 5).map((item) => ({
      id: item.conversation_id,
      title: item.title,
      scope: item.source_scope
    }))
  });

  return links;
}

const AUTH_TOKEN_TTL_MS = 10 * 60 * 1000;
let cachedAuthToken = "";
let cachedAuthTokenAt = 0;

async function getAuthToken(forceRefresh = false) {
  if (!forceRefresh && cachedAuthToken && (Date.now() - cachedAuthTokenAt) < AUTH_TOKEN_TTL_MS) {
    return cachedAuthToken;
  }
  const response = await fetch("/api/auth/session");
  if (!response.ok) {
    throw new Error(`auth_status_${response.status}`);
  }
  const data = await response.json();
  if (!data.accessToken) {
    throw new Error("auth_token_missing");
  }
  cachedAuthToken = data.accessToken;
  cachedAuthTokenAt = Date.now();
  return cachedAuthToken;
}

async function extractConversationViaApi(convId) {
  const controller = new AbortController();
  const timeoutMs = 30000;
  const timer = setTimeout(() => controller.abort("extract_timeout"), timeoutMs);
  try {
    let token = await getAuthToken(false);
    let resp = await fetch(`/backend-api/conversation/${convId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    if (resp.status === 401) {
      token = await getAuthToken(true);
      resp = await fetch(`/backend-api/conversation/${convId}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal
      });
    }
    if (!resp.ok) {
      return { ok: false, error: `api_status_${resp.status}` };
    }
    const data = await resp.json();
    return { ok: true, conversation: transformApiConversation(data) };
  } catch (err) {
    const message = err?.name === "AbortError" ? "extract_timeout" : err.message;
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

function transformApiConversation(apiData) {
  const messages = [];
  const mapping = apiData.mapping || {};
  let node = apiData.current_node;
  const thread = [];

  while (node && mapping[node]) {
    if (mapping[node].message) thread.push(mapping[node].message);
    node = mapping[node].parent;
  }
  thread.reverse();

  thread.forEach((msg, index) => {
    const parts = msg.content?.parts || [];
    const content = parts.map((part) => (typeof part === "string" ? part : part.text || "")).join("\n");

    messages.push({
      index,
      role: msg.author?.role || "unknown",
      timestamp: msg.create_time ? new Date(msg.create_time * 1000).toISOString() : "",
      content
    });
  });

  return {
    conversation_id: apiData.conversation_id || apiData.id,
    conversation_title: apiData.title || "",
    messages
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "COLLECT_CONVERSATIONS") {
    collectConversationLinks(message.options || {})
      .then((links) => sendResponse({ ok: true, links }))
      .catch((err) => sendResponse({ ok: false, error: err.message, links: [] }));
    return true;
  }

  if (message?.type === "EXTRACT_CONVERSATION") {
    extractConversationViaApi(message.conversation_id || message.conversationId).then((res) => sendResponse(res));
    return true;
  }

  if (message?.type === "GET_DOM_PROJECT_TITLE") {
    try {
      const titleBtn = document.querySelector('button[name="project-title"]');
      if (titleBtn) {
        const titleText = (titleBtn.textContent || "").trim();
        sendResponse({ ok: true, title: titleText });
      } else {
        sendResponse({ ok: false, error: "not_found" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return false;
  }
});
