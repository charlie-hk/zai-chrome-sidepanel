// Z.ai Sidepanel Agent — panel logic
// Talks to chat.z.ai with the user's own logged-in session token
// (localStorage.token), implements the site's request signing, streams
// SSE completions, and drives an on-page agent (read/click/type/scroll).

"use strict";

// build marker — verify in DevTools console of the side panel
console.log("[Sidebar Agent] build 1.0.18 — signed release © 2026 A.Amini (integrity self-check in the background worker); compliance pass: no remotely hosted code anywhere, Disconnect/Clear-chat data controls, hardened markdown links");

/* ═══════════════════════════ constants ═══════════════════════════ */

const BASE_URL = "https://chat.z.ai";
const SALT_KEY = "key-@@@@)))()((9))-xxxx&&&%%%%%"; // extracted from the web app bundle
const DEFAULT_FE_VERSION = "prod-fe-1.1.128";
// chat.z.ai removed all glm-4.x models — requests with a dead model get
// HTTP 500, and the first entry of /api/models is "x-preview-l", a
// captcha-gated preview model that answers with FRONTEND_CAPTCHA_REQUIRED
// ("Please refresh the page to update the app"). Default to the site's
// own default model instead, and migrate stale saved selections.
const DEFAULT_MODEL = "glm-5.3";
const PREFERRED_MODELS = ["glm-5.3", "glm-5.2"];
const FALLBACK_MODELS = ["glm-5.3", "glm-5.2", "x-preview-l"];
const USER_AGENT_PARAM =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0";
const MAX_AGENT_STEPS = 10;

const SYSTEM_PROMPT = `You are Z.ai Sidepanel Agent — a browser-automation agent in a Chrome side panel next to the user's active tab. You CONTROL that tab: the extension really executes your action blocks (this is exactly what the user installed you for; risky steps are shown to the user for approval first). You are NOT the plain chat.z.ai assistant.

TOOL REALITY (remember this): the fenced \`\`\`action blocks listed below are your ONLY tools — and the extension really executes them in the tab. You have no other "function list": if you catch yourself reasoning about tools like web_search / WebSearch / WebFetch / a code interpreter, stop — those do not exist in this session, and replies like "I cannot control the browser", "I have no tools" or "I only have web search and page reader" are FALSE here. Also, everything you output is shown to the user verbatim — never expose private deliberation ("Let me think…", self-analysis, capability inventories, meta commentary about the user). Your visible reply is either a one-line plan + one action block, or the final answer in the user's language.

The user's active browser tab arrives as a [PAGE SNAPSHOT] message — it is not a screenshot, it is the live DOM of that tab. "this page" always means that page; ground every answer about it in the snapshot. If you instead see [PAGE SNAPSHOT UNAVAILABLE], the extension could not read the tab: say exactly that and suggest opening a normal website tab (or reloading it with F5). Interactive elements carry stable ids like "e12" — use those ids as targets.

FILES FROM THE USER'S DISK: a [PROJECT FILES BRIDGE] message lists files the user attached with the panel's 📎 button (a local folder or files). You have no shell, no git and no direct disk access — never fake command output and never pretend to read files that were not attached. When that message is present, you can publish those files on any site with a web upload: send {"action":"upload", ...} and the extension feeds the real files into the page's file picker. When it is absent and the task needs local files (e.g. "put my project on GitHub"), do the file-free part first (e.g. create the repository) and ask the user to click 📎 and pick the project folder.

To act on the page, output a fenced block exactly like:
\`\`\`action
{"action":"<name>", ...}
\`\`\`
Available actions:
- {"action":"click","target":"e12"}                          — click a tagged element
- {"action":"type","target":"e7","text":"hello"}             — clear and type into an input/textarea/contenteditable (types nothing else)
- {"action":"press","key":"Enter","target":"e7"}             — press a key on the element (Enter by default; target optional) — submits searches/forms
- {"action":"scroll","direction":"down|up|top|bottom"}       — scroll the page
- {"action":"extract","query":"css selector"}                — pull innerText of ALL matching elements (joined)
- {"action":"read"}                                          — request a fresh page snapshot
- {"action":"navigate","url":"https://…"}                    — open a URL in this tab; the fastest way to search (e.g. YouTube: https://www.youtube.com/results?search_query=…)
- {"action":"upload","files":"all"}                          — feed the 📎-attached files into the current page's file input; "files" may also be an array of paths like ["manifest.json","panel/sidepanel.js"]; optional "target" = CSS selector for the file input
- {"action":"done","final":"<message for the user>"}         — you are finished; deliver the final answer

Rules:
- When the user asks you to DO something on the page (open, play, search, fill, click, upload, publish), you must act with action blocks until it is done. NEVER reply with instructions for the user to do it themselves, and NEVER claim you cannot click/type/navigate.
- After each action you will receive a [TOOL RESULT] message. Continue step by step until you can answer.
- "target" accepts a snapshot id (e12) OR a CSS selector like a[href*='name']; "extract" takes a CSS "query" ("selector" also works) and returns ALL matches; navigate accepts relative URLs like /repo-name.
- Only one action block per reply. You may also write a short plan before the block.
- When no action is needed, just answer in plain text (markdown allowed).
- LANGUAGE: always reply in the language the user writes in (Persian → Persian, English → English, etc.). Your very first reply after the user connects must include exactly this line: "Now you can chat in your language".
- Never submit payments, enter passwords, delete data or send messages on the user's behalf unless the user explicitly asked for exactly that.
- If the snapshot lacks information you need, use "extract" or "read" rather than guessing.

Example — user: "play Gole Yakh on YouTube":
I'll search YouTube for it.
\`\`\`action
{"action":"type","target":"e12","text":"gole yakh"}
\`\`\`
(then, after the [TOOL RESULT], press Enter and click the first video)

Example — user: "put my project on GitHub" (they attached the folder with 📎):
Step 1 — create the repo: navigate to https://github.com/new, then read, type the repo name, click "Create repository".
Step 2 — upload per directory (a GitHub upload page fills its own folder): navigate to https://github.com/<owner>/<repo>/upload/main, send {"action":"upload","files":[<root files>]}, type a commit message, click "Commit changes"; then for each subfolder (panel, agent, icons) navigate to /upload/main/<folder> and upload that group.
Step 3 — {"action":"done","final":"…"} with the repo link.`;

/* ═══════════════════════════ state ═══════════════════════════ */

const state = {
  token: "",
  userId: "",
  userName: "",
  feVersion: DEFAULT_FE_VERSION,
  model: DEFAULT_MODEL,
  confirmMode: true,
  autoAttach: true,
  chatId: "", // client-generated UUID; materializes on chat.z.ai with first message
  chatTitle: "New chat",
  messages: [], // {role, content}
  attached: null, // {tabId, url, title, snapshot}
  pageNote: null, // why no page snapshot could be attached this turn
  busy: false,
  abort: null,
  captchaToken: "", // fresh aliyun captcha payload, consumed by the next request
  captchaNeeded: false, // set when the server demands a captcha; while set, a fresh
                        // token is solved before each attempt — cleared again as soon
                        // as a request succeeds (optimistic, like the site: most of
                        // its own requests go out without a token)
  fileBridge: [] // 📎 files attached from the user's disk: {path, size, text, file}
};

const $ = (id) => document.getElementById(id);

/* ═══════════════════════════ tiny helpers ═══════════════════════════ */

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx".replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16)
  );
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function mdLite(s) {
  let out = esc(s);
  out = out.replace(/```([\s\S]*?)```/g, (_, c) => `<pre class="code">${c.trim()}</pre>`);
  out = out.replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>');
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  // links: only allow clean http(s) URLs (no quotes/backslashes) and escape
  // any " before it lands inside an href attribute — untrusted model/page
  // text can otherwise break out of the attribute (CWS safe-data handling)
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (m, label, url) => {
    const safe = /^[^\s"'`<>\\]+$/.test(url) ? url.replace(/"/g, "%22") : null;
    return safe
      ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : m;
  });
  return out.replace(/\n/g, "<br/>");
}

function toast(msg, ms = 3500) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), ms);
}

function decodeJwtPayload(token) {
  try {
    const part = token.split(".")[1];
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(decodeURIComponent(escape(atob(b64))));
  } catch {
    return {};
  }
}

async function hmacSha256Hex(keyStr, msgStr) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(keyStr),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msgStr));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/* ═══════════════════════════ Z.ai client ═══════════════════════════ */

let lastFeCheck = 0;
async function ensureFeVersion(force) {
  const now = Date.now();
  if (!force && now - lastFeCheck < 60000) return; // refresh at most once a minute
  lastFeCheck = now;
  try {
    // credentials: attach the user's real chat.z.ai cookies (session + the
    // anti-bot cookies Aliyun's WAF sets). Extension fetches default to
    // credentials "same-origin", which means NO cookies — cookieless requests
    // get bot-scored and eventually blocked with the Aliyun WAF "405" page.
    const res = await fetch(BASE_URL + "/", {
      method: "GET",
      credentials: "include"
    });
    const html = await res.text();
    const m = html.match(/prod-fe-\d+\.\d+\.\d+/);
    if (m) state.feVersion = m[0];
  } catch {
    /* keep current — an outdated value makes the server answer 426 */
  }
}

async function guestToken() {
  const headers = { "Content-Type": "application/json" };
  await fetch(BASE_URL + "/api/v1/auths/guest", {
    method: "POST",
    headers,
    credentials: "include",
    body: "{}"
  }).catch(() => {});
  const res = await fetch(BASE_URL + "/api/v1/auths/", {
    headers,
    credentials: "include"
  });
  if (!res.ok) throw new Error("guest auth failed (" + res.status + ")");
  const j = await res.json();
  if (!j.token) throw new Error("no guest token");
  return j.token;
}

async function generateZaSignature(prompt) {
  const tsMs = Date.now();
  const timestamp = String(tsMs);
  const requestId = uuid();
  const bucket = Math.floor(tsMs / 300000);
  const wKey = await hmacSha256Hex(SALT_KEY, String(bucket));
  // sorted by key: requestId < timestamp < user_id
  const sortedPayload = `requestId,${requestId},timestamp,${timestamp},user_id,${state.userId}`;
  const promptB64 = b64Utf8(prompt.trim());
  const dataToSign = sortedPayload + "|" + promptB64 + "|" + timestamp;
  const signature = await hmacSha256Hex(wKey, dataToSign);

  const q = new URLSearchParams({
    timestamp,
    requestId,
    user_id: state.userId,
    version: "0.0.1",
    platform: "web",
    token: state.token,
    user_agent: USER_AGENT_PARAM,
    language: "en-US",
    screen_resolution: "1920x1080",
    viewport_size: "1920x1080",
    timezone: "Europe/Paris",
    timezone_offset: "-60",
    signature_timestamp: timestamp
  });
  return { signature, urlParams: q.toString() };
}

/**
 * Escape < and > as JSON unicode escapes. The server's JSON parser decodes
 * them back — the model sees byte-identical text — but the raw request body
 * no longer contains XSS-looking byte patterns (e.g. "<script") that page
 * snapshots legitimately contain and the Aliyun WAF in front of chat.z.ai
 * answers with its zh-cn "405" block page.
 */
function jsonBodySafe(o) {
  return JSON.stringify(o).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

/**
 * Stream one completion. `onDelta(reasoningDelta, contentDelta)` per tick.
 * Returns the final {content, reasoning}.
 */
async function streamCompletionOnce({ messages, chatId, onDelta, signal }) {
  // sign the last user message
  let lastUser = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUser =
        typeof messages[i].content === "string"
          ? messages[i].content
          : JSON.stringify(messages[i].content);
      break;
    }
  }
  const { signature, urlParams } = await generateZaSignature(lastUser);
  await ensureFeVersion(); // an outdated X-FE-Version gets HTTP 426 "refresh the page"

  // Message ids are client-generated, mirroring the chat.z.ai web app
  // (prod-fe-1.1.128): id = the new assistant message, session_id = chat id,
  // current_user_message_id = the user message that triggered this reply.
  // Omitting "id" makes the backend reject the request with
  // MISSING_MESSAGE_ID ("message id (id) is required").
  const body = {
    stream: true,
    model: state.model,
    messages: messages.map((m) => ({ ...m, id: uuid() })),
    signature_prompt: lastUser.trim(),
    params: {},
    features: {
      enable_thinking: true,
      flags: [],
      image_generation: false,
      web_search: false,
      auto_web_search: false
    },
    variables: {},
    session_id: chatId,
    chat_id: chatId,
    id: uuid(),
    current_user_message_id: uuid(),
    current_user_message_parent_id: null,
    captcha_verify_param: state.captchaToken || ""
  };

  const res = await fetch(BASE_URL + "/api/v2/chat/completions?" + urlParams, {
    method: "POST",
    headers: {
      "authorization": "Bearer " + state.token,
      "content-type": "application/json",
      "X-FE-Version": state.feVersion,
      "Accept-Language": "en-US,en;q=0.9",
      "x-region": "overseas",
      "x-signature": signature
    },
    body: jsonBodySafe(body),
    credentials: "include", // session + WAF cookies, like the site's own XHRs
    signal
  });

  // captcha tokens are single-use — whatever we attached was consumed by
  // this exact request; never let the next one reuse it
  state.captchaToken = "";

  if (res.status === 401) throw new Error("Session expired — click Connect again.");
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    // An HTML error page here is the Aliyun WAF/edge block page in front of
    // chat.z.ai (zh-cn "<title>405</title>" + data-spm marker) — not an app
    // error. Never dump its HTML into the chat; flag it for the heal loop.
    // (503 stays out of this branch — an HTML 503 is an edge/capacity page
    // and belongs to the capacity heal, not the WAF heal.)
    if (
      res.status !== 503 &&
      (/^\s*<!doctype html/i.test(txt) ||
        /<title>\s*405/i.test(txt) ||
        /data-spm/i.test(txt))
    ) {
      const err = new Error(
        "Z.ai's protection layer (WAF) blocked this request (HTTP " +
        res.status + ")."
      );
      err.status = res.status;
      err.waf = true;
      throw err;
    }
    const looksHtml = /^\s*<(?:!doctype|html)/i.test(txt);
    const err = new Error(
      "chat.z.ai error " + res.status +
      (looksHtml
        ? " — an HTML error page (edge/CDN), not a chat response"
        : ": " + txt.slice(0, 300))
    );
    err.status = res.status;
    if (res.status === 503 || /at capacity/i.test(txt)) err.capacity = true;
    throw err;
  }

  // The server accepted this request → its risk check is satisfied for now.
  // Clear the demand flag (optimistic mode): the next request goes out
  // WITHOUT a token, exactly like the site's own traffic. If the server
  // demands a captcha again, the heal loop in streamCompletion catches it
  // and solves a fresh token.
  state.captchaNeeded = false;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let raw = ""; // accumulated upstream text (details tags included)
  let seenContent = "";
  let seenReasoning = "";
  let done = false;

  const splitDetails = (s) => {
    let rb = "", cb = "", rest = s;
    for (;;) {
      const idx = rest.indexOf("<details");
      if (idx < 0) { cb += rest; break; }
      cb += rest.slice(0, idx);
      const tagEnd = rest.indexOf(">", idx);
      if (tagEnd < 0) break;
      const after = rest.slice(tagEnd + 1);
      const closeIdx = after.indexOf("</details>");
      if (closeIdx < 0) { rb += after; break; }
      rb += after.slice(0, closeIdx);
      rest = after.slice(closeIdx + "</details>".length);
    }
    return { reasoning: rb, content: cb };
  };

  const cleanReasoning = (s) =>
    s.replace(/<details[^>]*>/g, "").replace(/<\/details>/g, "")
      .split("\n").map((l) => l.replace(/^> /, "")).join("\n").trim();

  while (!done) {
    const { value, done: rdDone } = await reader.read();
    if (rdDone) break;
    buf += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data: ")) continue;
      const dataStr = line.slice(6);
      if (dataStr === "[DONE]") { done = true; break; }

      let j;
      try { j = JSON.parse(dataStr); } catch { continue; }

      const d = j && j.data;
      const errObj = (d && d.error) || (j && j.error) || null;
      if (errObj) {
        const eCode = String(errObj.error_code || errObj.code || "");
        const eDetail = String(errObj.detail || errObj.message || "");
        if (/FRONTEND_CAPTCHA_REQUIRED/i.test(eCode)) {
          throw new Error(
            "Z.ai requires a captcha verification for this request " +
            "(model \"" + state.model + "\") — the extension will try to " +
            "solve it automatically in your chat.z.ai tab."
          );
        }
        if (/user level/i.test(eDetail)) {
          throw new Error(
            'Z.ai: your account level cannot use the model "' + state.model +
            '". Pick another model in the dropdown (glm-5.3 / glm-5.2).'
          );
        }
        if (eDetail) {
          const err = new Error("Z.ai: " + eDetail);
          if (/at capacity/i.test(eDetail) || /CAPACITY/i.test(eCode)) {
            err.capacity = true;
          }
          throw err;
        }
      }
      if (d && d.phase === "done") { done = true; break; }

      if (d) {
        if (typeof d.edit_content === "string" && d.edit_content) {
          const idx = typeof d.edit_index === "number" ? d.edit_index : 0;
          raw = raw.substring(0, idx) + d.edit_content; // JS strings are UTF-16 — matches the web app
        } else if (typeof d.content === "string" && d.content) {
          raw = d.content;
        } else if (typeof d.delta_content === "string" && d.delta_content) {
          raw += d.delta_content;
        }
      }

      const { reasoning, content } = splitDetails(raw);
      const rDelta = reasoning.startsWith(seenReasoning)
        ? reasoning.slice(seenReasoning.length)
        : "";
      if (rDelta) seenReasoning = reasoning;
      const cDelta = content.startsWith(seenContent)
        ? content.slice(seenContent.length)
        : "";
      if (cDelta) seenContent = content;
      if ((rDelta || cDelta) && onDelta) onDelta(rDelta, cDelta);
    }
  }

  const { reasoning, content } = splitDetails(raw);
  return { content: content.trim(), reasoning: cleanReasoning(reasoning) };
}

/**
 * chat.z.ai now demands an Aliyun captcha token with every completion
 * (captcha_verify_param). The token is domain-bound and single-use, so the
 * background service worker runs the site's own widget (fresh instance per
 * solve, like the site's tR()) inside the user's chat.z.ai tab and returns
 * the success payload + a diagnostic stage.
 */
async function getCaptchaToken() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "GET_ZAI_CAPTCHA" });
    if (resp && resp.ok && resp.captcha) {
      return { token: resp.captcha, stage: resp.stage || "success" };
    }
    return { token: "", stage: (resp && (resp.stage || resp.error)) || "no_response" };
  } catch {
    return { token: "", stage: "background_unreachable" };
  }
}

function captchaFailText(stage) {
  const base = 'Z.ai demands a captcha and the automatic solve did not return one';
  const s = String(stage || "");
  if (/script_missing|init_failed|init_timeout/.test(s)) {
    return base + " (the captcha widget could not start in the chat.z.ai tab). " +
      "Reload chat.z.ai once (F5), make sure you are logged in, then try again.";
  }
  if (/timeout_challenge|closed_after_challenge/.test(s)) {
    return base + " — a verification slider appeared in the chat.z.ai tab but " +
      "was not solved in time. Switch to the chat.z.ai tab, drag the slider, " +
      "then try again.";
  }
  if (/onClose/.test(s)) {
    return base + " (the verification popup closed without completing). " +
      "Try again — if a slider appears in the chat.z.ai tab, drag it once.";
  }
  if (/onError|execute_failed/.test(s)) {
    return base + " (the captcha service errored). Try again in a minute.";
  }
  if (/not_logged_in|no_tab/.test(s)) {
    return base + " — no logged-in chat.z.ai tab was found. Open chat.z.ai, " +
      "log in, then try the panel again.";
  }
  return base + ". Open chat.z.ai in a normal tab (stay logged in), then try the panel again.";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abortedOpt = (opts) => !!(opts.signal && opts.signal.aborted);

// Reload the user's chat.z.ai tab: a full page load runs the site's own WAF
// JS challenge (acw_* cookies are computed by obfuscated JS — a plain fetch
// of the homepage can never execute it) and refreshes every protection
// cookie. This is the same remedy the final error message suggests, done
// automatically.
async function reloadZaiTab() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://chat.z.ai/*" });
    if (!tabs || !tabs.length) return false;
    const tab = tabs[0];
    await chrome.tabs.reload(tab.id);
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        try { chrome.tabs.onUpdated.removeListener(listener); } catch {}
        resolve();
      };
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === "complete") done();
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(done, 12000); // never hang the heal on a slow tab
    });
    await sleep(2000); // let the challenge JS settle
    return true;
  } catch {
    return false;
  }
}

// "Model is currently at capacity" is server-side load — retrying the same
// model once, then transparently switching to its sibling, fixes most cases.
function siblingModel(cur) {
  const prefs = PREFERRED_MODELS.filter((m) => m !== cur);
  if (prefs.length) return prefs[0];
  return cur === "glm-5.2" ? "glm-5.3" : "glm-5.2";
}

/**
 * Wrapper with self-healing. All heal paths live in ONE bounded retry loop,
 * so chained failures heal instead of surfacing:
 *   captcha → capacity, capacity → captcha (the single-use captcha token is
 *   consumed by every request, including one that 503s), stale FE version →
 *   capacity again, WAF block → lean retry, etc. Each heal type has its own
 *   budget and nothing is retried once text was streamed (no duplicated
 *   output):
 * - stale X-FE-Version (HTTP 426 / "refresh the page") → refresh + retry (1)
 * - FRONTEND_CAPTCHA_REQUIRED → solve a fresh token in the chat.z.ai tab
 *   and retry (up to 3 solves per turn)
 * - after any request succeeds the demand flag clears — the next request
 *   goes out without a token (site-like); a fresh solve only happens on a
 *   new demand or mid-chain after a consumed token
 * - Aliyun WAF block page (HTTP 405 + HTML) → reload the chat.z.ai tab (its
 *   page load runs the site's own WAF JS challenge), refresh cookies, pause,
 *   retry; from the second strike the payload goes lean (up to 3 WAF heals
 *   per turn)
 * - "Model is currently at capacity" (HTTP 503 / SSE error) → wait ~3s,
 *   retry the same model once, then switch to the sibling model
 *   (glm-5.3 ↔ glm-5.2) and retry (up to 3 capacity heals per turn)
 * Every step is announced in the chat so the user sees what happens.
 */
async function streamCompletion(opts) {
  let emitted = false;
  const tracked = opts.onDelta
    ? (r, c) => { emitted = true; opts.onDelta(r, c); }
    : undefined;
  let useLean = false; // WAF retry #2 sends a trimmed payload
  const run = () =>
    streamCompletionOnce({
      ...opts,
      messages:
        useLean && opts.leanMessages ? opts.leanMessages() : opts.messages,
      onDelta: tracked
    });

  const BUDGET = { stale: 1, captcha: 3, waf: 3, capacity: 3, total: 13 };
  let capStrikes = 0; // consecutive capacity failures this turn
  let capSwitched = false; // sibling model already tried
  let wafStrikes = 0; // WAF block pages seen this turn
  let captchaRefills = 0; // captcha token refills announced this turn
  let lastErr = null;

  for (let attempt = 1; attempt <= BUDGET.total; attempt++) {
    if (abortedOpt(opts)) throw new Error("aborted by user");

    // captcha still demanded (a demand happened, no success since) → solve a
    // fresh token BEFORE sending, so the attempt already carries one. The
    // token is single-use and streamCompletionOnce clears it after every
    // request — including requests that fail with 503 — so this refill is
    // what makes capacity→captcha chains heal silently. After a SUCCESS the
    // flag clears (optimistic mode): the next request goes out without a
    // token, exactly like the site's own traffic, and only re-solves on a
    // new demand — the tab stops being yanked to the front on every step.
    if (state.captchaNeeded && !state.captchaToken && !emitted) {
      captchaRefills++;
      addMsgEl(
        "tool",
        captchaRefills === 1
          ? "🔐 Solving the Z.ai captcha check — your chat.z.ai tab will come to the front for a moment; if a slider appears there, drag it once."
          : "🔐 The previous request consumed the captcha token — solving a fresh one; your chat.z.ai tab will come to the front for a moment; drag the slider once if it appears."
      );
      const solved = await getCaptchaToken();
      if (!solved.token) throw new Error(captchaFailText(solved.stage));
      state.captchaToken = solved.token;
    }

    try {
      const r = await run();
      return r;
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || "");
      if (emitted || abortedOpt(opts)) throw e; // never duplicate streamed text

      // 1) stale X-FE-Version → refresh + retry
      const stale =
        (e.status === 426 || /refresh the page|update the app/i.test(msg)) &&
        !/captcha/i.test(msg);
      if (stale && BUDGET.stale-- > 0) {
        await ensureFeVersion(true);
        continue;
      }

      // 2) captcha demanded — also right after a capacity retry, because
      //    the failed request consumed the previous token
      if (/captcha/i.test(msg) && BUDGET.captcha-- > 0) {
        state.captchaNeeded = true;
        addMsgEl("tool", "🔐 Z.ai wants a captcha check — bringing your chat.z.ai tab to the front; if a slider appears there, drag it once.");
        await ensureFeVersion(true);
        const solved = await getCaptchaToken(); // always a fresh solve — never reuse
        if (!solved.token) throw new Error(captchaFailText(solved.stage));
        state.captchaToken = solved.token;
        continue;
      }

      // 3) Aliyun WAF block page — reloading the chat.z.ai tab is the only
      //    thing that can run the WAF's own JS challenge (a fetched homepage
      //    returns the challenge HTML but never executes it). From the
      //    second strike the payload also goes lean.
      const waf = e.waf || e.status === 405;
      if (waf && BUDGET.waf-- > 0) {
        wafStrikes++;
        if (wafStrikes >= 2 && opts.leanMessages) {
          useLean = true;
          addMsgEl("tool", "🛡 Still blocked by Z.ai's protection layer — reloading the chat.z.ai tab and retrying with a leaner request (shorter history, no page snapshot)…");
        } else {
          addMsgEl("tool", "🛡 Z.ai's protection layer blocked the request — reloading the chat.z.ai tab to lift the block, then retrying…");
        }
        await reloadZaiTab();
        await ensureFeVersion(true); // re-touch homepage → fresh cookies in this session too
        await sleep(4000);
        continue;
      }

      // 4) capacity → wait, retry the same model once, then the sibling once
      const capacity = e.capacity || e.status === 503 || /at capacity/i.test(msg);
      if (capacity && BUDGET.capacity-- > 0) {
        capStrikes++;
        const tried = state.model;
        const sib = siblingModel(tried);
        if (capStrikes >= 2 && !capSwitched && PREFERRED_MODELS.includes(tried)) {
          capSwitched = true;
          addMsgEl("tool", `↩ Still at capacity — switching model "${tried}" → "${sib}" and retrying…`);
          state.model = sib;
          const sel = $("modelSelect");
          if ([...sel.options].some((o) => o.value === sib)) {
            sel.value = sib;
            $("modelCustom").value = "";
          } else {
            $("modelCustom").value = sib;
          }
          saveSettings();
        } else {
          addMsgEl("tool", `⏳ "${tried}" is at capacity — waiting a few seconds, then retrying…`);
        }
        await sleep(3000);
        continue;
      }

      // budget exhausted or unknown error → one clear final message
      if (waf) {
        throw new Error(
          "Z.ai's protection layer (WAF) kept blocking the request even after " +
          "a cookie refresh and a lean retry. Open chat.z.ai in a normal tab and " +
          "send one message there — that lifts the block — then try the panel again."
        );
      }
      if (capacity) {
        throw new Error(
          'Z.ai: "' + state.model + '" is still at capacity after several retries' +
          (capSwitched ? " and a fallback-model switch" : "") +
          " — the servers are loaded right now. Try again in a few minutes."
        );
      }
      if (/captcha/i.test(msg)) {
        throw new Error(
          "Z.ai kept demanding a captcha even after repeated automatic solves " +
          "(server-side risk control on this account/IP). Open chat.z.ai in a " +
          "normal tab, send any message once — solve the slider if it appears — " +
          "then try the panel again."
        );
      }
      throw e;
    }
  }

  // total budget exhausted — summarize by error family
  const msg = String((lastErr && lastErr.message) || "");
  if (lastErr && (lastErr.waf || lastErr.status === 405)) {
    throw new Error(
      "Z.ai's protection layer (WAF) kept blocking the request even after " +
      "a cookie refresh and a lean retry. Open chat.z.ai in a normal tab and " +
      "send one message there — that lifts the block — then try the panel again."
    );
  }
  if (/captcha/i.test(msg)) {
    throw new Error(
      "Z.ai kept demanding a captcha even after repeated automatic solves " +
      "(server-side risk control on this account/IP). Open chat.z.ai in a " +
      "normal tab, send any message once — solve the slider if it appears — " +
      "then try the panel again."
    );
  }
  if (lastErr && (lastErr.capacity || lastErr.status === 503 || /at capacity/i.test(msg))) {
    throw new Error(
      'Z.ai: "' + state.model + '" and its fallback stayed at capacity after ' +
      "several retries — the servers are loaded right now. Try again in a few minutes."
    );
  }
  throw lastErr || new Error("chat.z.ai request failed");
}

/* ── sessions ─────────────────────────────────────────────── */

async function listChats() {
  const res = await fetch(BASE_URL + "/api/v1/chats/?page=1", {
    headers: { authorization: "Bearer " + state.token },
    credentials: "include"
  });
  if (res.status === 401) throw new Error("Session expired — click Connect again.");
  if (!res.ok) throw new Error("chats list failed (" + res.status + ")");
  const j = await res.json();
  const arr = Array.isArray(j) ? j : j.chats || j.data || [];
  return arr
    .map((c) => ({
      id: c.id,
      title: c.title || "(untitled)",
      updated_at: c.updated_at || c.updatedAt || 0
    }))
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
    .slice(0, 40);
}

async function loadChatMessages(chatId) {
  const res = await fetch(BASE_URL + "/api/v1/chats/" + chatId, {
    headers: { authorization: "Bearer " + state.token },
    credentials: "include"
  });
  if (!res.ok) return [];
  const j = await res.json();
  const chat = j.chat || j;
  const msgs = (chat && chat.messages) || [];
  return msgs
    .map((m) => ({
      role: m.role,
      content:
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((p) => (p && p.text) || "").join("")
            : ""
    }))
    .filter((m) => m.content);
}

async function refreshModels() {
  const sel = $("modelSelect");
  try {
    const res = await fetch(BASE_URL + "/api/models", {
      headers: { authorization: "Bearer " + state.token },
      credentials: "include"
    });
    if (!res.ok) throw new Error();
    const j = await res.json();
    let ids = Array.isArray(j)
      ? j.map((m) => (typeof m === "string" ? m : m.id || m.name))
      : (j.data || j.models || []).map((m) => (typeof m === "string" ? m : m.id || m.name));
    ids = [...new Set(ids.filter(Boolean))];
    if (!ids.length) throw new Error();
    // preferred current models first, preview/experimental models last
    ids.sort((a, b) => {
      const pa = PREFERRED_MODELS.indexOf(a), pb = PREFERRED_MODELS.indexOf(b);
      if (pa >= 0 || pb >= 0) return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
      return 0;
    });
    sel.innerHTML = ids.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join("");
    if (ids.includes(state.model)) {
      sel.value = state.model;
    } else {
      // saved model was removed server-side (e.g. glm-4.6) → migrate to the
      // site default, otherwise the dropdown silently lands on "x-preview-l",
      // a captcha-gated model that always errors.
      const next =
        PREFERRED_MODELS.find((m) => ids.includes(m)) ||
        ids.find((id) => !/^x-/.test(id)) ||
        ids[0];
      sel.value = next;
      toast(`Model "${state.model}" is no longer available — switched to "${next}".`);
      state.model = next;
      saveSettings();
    }
  } catch {
    sel.innerHTML = FALLBACK_MODELS.map(
      (id) => `<option value="${esc(id)}">${esc(id)}</option>`
    ).join("");
    if (!FALLBACK_MODELS.includes(state.model)) {
      sel.value = DEFAULT_MODEL;
      state.model = DEFAULT_MODEL;
      saveSettings();
    } else {
      sel.value = state.model;
    }
  }
  if ($("modelCustom").value.trim()) sel.value = "custom";
  syncModelFromUi();
}

function syncModelFromUi() {
  const custom = $("modelCustom").value.trim();
  state.model = custom || $("modelSelect").value || state.model;
  saveSettings();
}

/* ── connect ──────────────────────────────────────────────── */

async function connect() {
  setConn("Connecting…", "conn-off");
  let resp = await chrome.runtime.sendMessage({ type: "GRAB_ZAI_TOKEN" });
  if (!resp || !resp.ok) {
    // fall back to manual token if the user saved one
    const manual = (localStorage.getItem("zaiManualToken") || "").trim();
    if (manual) {
      resp = { ok: true, token: manual };
    } else {
      try {
        const t = await guestToken();
        resp = { ok: true, token: t, guest: true };
      } catch (e) {
        setConn("Not connected", "conn-off");
        toast("Connect failed: " + e.message);
        return;
      }
    }
  }
  state.token = resp.token;
  const payload = decodeJwtPayload(resp.token);
  state.userId = payload.id || payload.sub || "unknown";
  state.userName = resp.guest
    ? "Guest"
    : payload.email
      ? payload.email.split("@")[0]
      : payload.name || "user";
  localStorage.setItem("zaiManualToken", "");

  await ensureFeVersion();
  await refreshModels();
  renderSessions();
  setConn(
    resp.guest ? "Connected as Guest (limited models)" : "Connected: " + state.userName,
    "conn-on"
  );
  toast("Connected to Z.ai ✔");
  addMsgEl("tool", "Now you can chat in your language.");
}

function setConn(text, cls) {
  const el = $("connStatus");
  el.textContent = text;
  el.className = "conn " + cls;
}

/* ═══════════════════════════ page agent ═══════════════════════════ */

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensureAgentInjected(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => !!window.__zaiAgent
  });
  if (!result) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["agent/agent.js"]
    });
  }
}

async function callAgent(tabId, cmd) {
  await ensureAgentInjected(tabId);
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "ZAI_AGENT_CMD", cmd });
    return res || { error: "no response" };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}

const PAGE_BLOCKED_RE =
  /^(chrome|edge|about|devtools|view-source|chrome-extension|chrome-untrusted):/i;

function friendlyAttachReason(url) {
  if (/^chrome:\/\/new/i.test(url) || /^edge:\/\/new/i.test(url))
    return "the active tab is the browser's New Tab page — open a real website and ask again";
  if (PAGE_BLOCKED_RE.test(url))
    return 'Chrome does not let extensions read browser pages like "' +
      String(url).split("/")[0] + '" — switch to a normal website tab';
  if (/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url))
    return "Chrome protects the Web Store page from extensions";
  if (/^file:/i.test(url))
    return 'file:// pages need "Allow access to file URLs" in chrome://extensions';
  return "";
}

async function attachPage(force = false) {
  const tab = await activeTab();
  if (!tab || !tab.id) {
    return { ok: false, reason: "no active tab found" };
  }
  const url = tab.url || "";
  const blocked = friendlyAttachReason(url);
  if (blocked) return { ok: false, reason: blocked, url };
  if (!force && state.attached && state.attached.tabId === tab.id) {
    return { ok: true, attached: state.attached };
  }
  let snap;
  try {
    snap = await callAgent(tab.id, { action: "read" });
    if (snap.error) {
      // a fresh injection can race the first message — retry once
      await sleep(250);
      snap = await callAgent(tab.id, { action: "read" });
    }
  } catch (e) {
    const raw = String(e && e.message ? e.message : e);
    const friendly = /cannot access|protected|not be invoked|Cannot access/i.test(raw)
      ? "Chrome protects this page from extensions"
      : raw;
    return {
      ok: false,
      url,
      reason: friendly + " — reload the tab (F5) if it is a normal website"
    };
  }
  if (snap.error) {
    return { ok: false, url, reason: snap.error };
  }
  state.attached = {
    tabId: tab.id,
    url: snap.url,
    title: snap.title,
    snapshot: snap
  };
  state.pageNote = null;
  $("pageChip").classList.remove("hidden");
  $("pageChipText").textContent = snap.title + " — " + (snap.url || "");
  return { ok: true, attached: state.attached };
}

function detachPage() {
  state.attached = null;
  $("pageChip").classList.add("hidden");
}

function snapshotToContext(snap) {
  const elems = (snap.elements || [])
    .map((e) => `- [${e.id}] ${e.desc}`)
    .join("\n");
  const sel = String(snap.selection || "").trim();
  return (
    `[PAGE SNAPSHOT]\nURL: ${snap.url}\nTitle: ${snap.title}\n` +
    (sel ? `TEXT THE USER HAD SELECTED:\n"""\n${sel.slice(0, 1500)}\n"""\n` : "") +
    `VISIBLE TEXT (trimmed):\n"""\n${(snap.text || "").slice(0, 7000)}\n"""\n` +
    `INTERACTIVE ELEMENTS:\n${elems}`
  );
}

/* ── file bridge (📎): local files for upload/publish tasks ── */

// Only human-readable files cross the bridge — binaries are useless to the
// model and bloat the prompt. Uploads themselves carry ANY attached file.
const FILE_TEXT_EXT =
  /\.(txt|md|markdown|json|jsonc|js|mjs|cjs|jsx|ts|tsx|css|scss|sass|less|html|htm|xml|svg|yml|yaml|toml|ini|cfg|conf|properties|env|sh|bash|zsh|ps1|bat|py|pyw|rb|go|rs|java|kt|kts|c|h|cpp|hpp|cs|php|sql|csv|tsv|gitignore|gitattributes|editorconfig|npmrc|nvmrc|babelrc|prettierrc|eslintrc|lock|log|graphql|proto|dart|swift|lua|vue|svelte|astro|prisma|tf|hcl|gradle|cmake|rst|adoc)$/i;
const FILE_TEXT_NAME =
  /^(license|licence|readme|changelog|contributing|authors|notice|makefile|dockerfile|procfile|vagrantfile|rakefile|gemfile|\.gitignore|\.gitattributes|\.editorconfig|\.npmrc|\.nvmrc|\.env(\.[^/]*)?|\.babelrc|\.prettierrc|\.eslintrc(\.[^/]*)?|\.dockerignore)$/i;
const FILE_SKIP_DIR =
  /(^|\/)(node_modules|\.git|\.hg|\.svn|__pycache__|\.venv|venv|dist|build|out|coverage|\.next|\.nuxt|\.idea|\.vscode|\.gradle|target|vendor)(\/|$)/i;
const FILE_MAX_EACH = 200 * 1024;   // 200 KB per file
const FILE_MAX_FILES = 120;
const FILE_MAX_TOTAL = 512 * 1024;  // 512 KB in the bridge overall
const FILE_PROMPT_BUDGET = 100 * 1024; // contents embedded into the prompt

async function attachFiles(fileList) {
  const incoming = Array.from(fileList || []);
  if (!incoming.length) return;
  const skipped = [];
  let added = 0;
  let total = state.fileBridge.reduce((a, f) => a + f.size, 0);
  for (const f of incoming) {
    const rel = String(f.webkitRelativePath || f.name || "file").replace(/\\/g, "/");
    if (FILE_SKIP_DIR.test(rel)) continue;
    const base = rel.split("/").pop();
    if (!(FILE_TEXT_EXT.test(base) || FILE_TEXT_NAME.test(base))) {
      skipped.push(base + " (binary?)");
      continue;
    }
    if (f.size > FILE_MAX_EACH) { skipped.push(base + " (too large)"); continue; }
    if (state.fileBridge.some((x) => x.path === rel)) continue; // already in
    if (state.fileBridge.length >= FILE_MAX_FILES || total + f.size > FILE_MAX_TOTAL) {
      skipped.push(base + " (budget)");
      continue;
    }
    try {
      const text = await f.text();
      state.fileBridge.push({ path: rel, size: f.size, text, file: f });
      total += f.size;
      added++;
    } catch {
      skipped.push(base + " (unreadable)");
    }
  }
  if (added)
    addMsgEl("tool",
      `📎 Attached ${added} file(s) — ${state.fileBridge.length} in the bridge ` +
      `(${Math.max(1, Math.round(total / 1024))} KB). The agent can now read them and ` +
      `push them into web upload forms. Tip: right-click 📎 to clear.`);
  if (skipped.length)
    addMsgEl("tool",
      "📎 Skipped: " + skipped.slice(0, 5).join(", ") +
      (skipped.length > 5 ? ` +${skipped.length - 5} more` : ""));
  if (!added && !skipped.length)
    toast("No attachable text files found in that selection.");
  updateAttachBadge();
}

function updateAttachBadge() {
  const n = state.fileBridge.length;
  const b = $("btnFiles");
  if (!b) return;
  b.textContent = n ? "📎" + n : "📎";
  b.title = n
    ? n + " file(s) attached from your disk — click to add more, right-click to clear"
    : "Attach files or a project folder from your disk for the agent";
}

// Prompt-side view of the bridge: the tree always; contents when they fit
// (and never in lean WAF-retry payloads, which must stay small).
function fileBridgeContext(lean) {
  const files = state.fileBridge;
  const kb = (n) => Math.max(1, Math.round(n / 1024));
  let total = 0;
  for (const f of files) total += f.size;
  const tree = files
    .slice(0, 150)
    .map((f) => `- ${f.path} (${kb(f.size)} KB)`);
  if (files.length > 150) tree.push(`- … and ${files.length - 150} more`);
  const head =
    `[PROJECT FILES BRIDGE] ${files.length} file(s) from the user's disk are available ` +
    `(${kb(total)} KB). Push them into the current page's file input with ` +
    `{"action":"upload","files":"all"} or a path array (paths are relative to the picked folder).\n` +
    `File tree:\n` + tree.join("\n");
  if (lean) return head + "\n(contents omitted in this compact retry)";
  const bodies = [];
  const omitted = [];
  let used = 0;
  for (const f of files) {
    if (used + f.size <= FILE_PROMPT_BUDGET) {
      used += f.size;
      bodies.push(`==== ${f.path} ====\n${f.text}`);
    } else omitted.push(f.path);
  }
  return (
    head +
    (bodies.length ? "\n\nCONTENTS:\n" + bodies.join("\n\n") : "") +
    (omitted.length
      ? `\n\n(contents omitted for ${omitted.length} file(s) to keep the request small)`
      : "")
  );
}

function abToB64(buf) {
  const u = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < u.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(bin);
}

/* ── action parsing + execution ───────────────────────────── */

// Escape raw control characters that sit INSIDE string literals (models
// often emit real newlines/tabs inside "text" values, which is invalid JSON)
function fixRawControlChars(s) {
  let out = "", inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === "\\") { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

// Best-effort repair of JSON the model truncated mid-stream: drop the
// unterminated string/key, then close every open bracket in reverse order
function closeTruncated(s) {
  let inStr = false, esc = false;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let out = s;
  if (inStr) {
    const q = out.lastIndexOf('"');
    if (q >= 0) out = out.slice(0, q);
  }
  // a dangling `"key":` or trailing comma can never become valid — drop it
  out = out.replace(/[,\s]*"[^"]*"\s*:\s*$/, "").replace(/[,\s]+$/, "");
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === "{" ? "}" : "]";
  return out;
}

// Generate an ordered list of repaired candidates and let JSON.parse judge
function repairCandidates(raw) {
  const outs = [];
  const add = (s) => {
    if (typeof s === "string" && s.length && outs.indexOf(s) === -1) outs.push(s);
  };
  // pipeline A: straight quotes are the delimiters (« » stay as content — legal in JSON)
  // pipeline B: the model used curly/guillemet quotes as delimiters
  const variants = [raw];
  variants.push(
    String(raw)
      .replace(/[\u201C\u201D\u201E\u201F\u2018\u2019\u2032\u2033]/g, '"')
      .replace(/\u00AB/g, "\\u00ab")
      .replace(/\u00BB/g, "\\u00bb")
  );
  for (let v of variants) {
    // isolate the outermost {...} (drops leading "action"/"json"/prose)
    const f = v.indexOf("{"), l = v.lastIndexOf("}");
    if (f >= 0 && l > f) v = v.slice(f, l + 1);
    let a = v.replace(/\u060C(?=\s*["}\]])/g, ",");     // Arabic comma (U+060C) in list position
    a = a.replace(/\/\*[\s\S]*?\*\//g, "");          // block comments
    add(a);
    let b = a.replace(/,\s*([}\]])/g, "$1");         // trailing commas
    add(b);
    let c = b.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3'); // unquoted keys
    add(c);
    let d = c.replace(/'([^'\\\n]*)'/g, '"$1"');     // single-quoted strings
    add(d);
    const e = fixRawControlChars(d);                 // raw newlines/tabs in strings
    add(e);
    add(closeTruncated(e));                          // truncation repair
    add(closeTruncated(b));
  }
  return outs;
}

function tryParseActionJSON(txt) {
  for (const cand of repairCandidates(String(txt || ""))) {
    try {
      const v = JSON.parse(cand);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {}
  }
  return null;
}

// Collect fenced blocks whose language tag could carry an action
function extractActionBlocks(text) {
  const blocks = [];
  const re = /```[ \t]*([A-Za-z_-]*)[ \t]*\r?\n?([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) {
    const lang = (m[1] || "").toLowerCase();
    if (!lang || lang === "action" || lang === "json" || lang === "actionjson" ||
        lang === "js" || lang === "javascript") {
      blocks.push({ lang, body: m[2] });
    }
  }
  // model ran out of tokens mid-block (no closing fence) — still try to
  // repair; scan only the text OUTSIDE closed blocks so a normal ```json
  // sample never masquerades as an unterminated action fence
  const tail = text.replace(/```[ \t]*[A-Za-z_-]*[ \t]*\r?\n?[\s\S]*?```/g, "");
  const unclosed = tail.match(/```[ \t]*(?:action|json)?[ \t]*\r?\n?(\{[\s\S]+)$/);
  if (unclosed) blocks.push({ lang: "unclosed", body: unclosed[1] });
  return blocks;
}

function parseAction(text) {
  let firstBroken = null;
  for (const b of extractActionBlocks(text)) {
    const obj = tryParseActionJSON(b.body);
    if (obj && typeof obj.action === "string") return obj;
    // only a block the model explicitly tagged "action" counts as a broken
    // action attempt — a plain ```json code sample is just illustrative
    if (
      !firstBroken &&
      (b.lang === "action" || b.lang === "unclosed") &&
      /\{/.test(b.body)
    ) {
      firstBroken = b.body;
    }
  }
  // no usable fence — maybe the model wrote the JSON inline
  const bare = tryParseActionJSON(text);
  if (bare && typeof bare.action === "string") return bare;
  if (firstBroken) {
    return { action: "error", error: "unparseable action block", raw: firstBroken };
  }
  return null;
}

function approveAction(jsonStr) {
  return new Promise((resolve) => {
    $("pendingAction").classList.remove("hidden");
    $("pendingCode").textContent = jsonStr;
    const finish = (val) => {
      $("pendingAction").classList.add("hidden");
      $("btnApprove").onclick = null;
      $("btnSkip").onclick = null;
      resolve(val);
    };
    $("btnApprove").onclick = () => finish(true);
    $("btnSkip").onclick = () => finish(false);
  });
}

async function executeAction(act) {
  if (!state.attached) {
    const at = await attachPage(true);
    if (!at.ok) return "[TOOL RESULT] error: no attachable page — " + at.reason;
  }
  const tabId = state.attached.tabId;

  const needsConfirm =
    state.confirmMode &&
    ["click", "type", "press", "navigate", "upload"].includes(act.action);
  if (needsConfirm) {
    const ok = await approveAction(JSON.stringify(act, null, 2));
    if (!ok) return "[TOOL RESULT] skipped by user";
  }

  let cmd = act;
  if (act.action === "upload") {
    // resolve the model's file list against the 📎 bridge and attach real
    // payloads — the model only ever NAMES paths, it never ships contents
    if (!state.fileBridge.length)
      return "[TOOL RESULT] error: no files attached yet — ask the user to click 📎 in the panel and pick the project folder first";
    let subset = state.fileBridge;
    if (act.files && act.files !== "all") {
      const want = (Array.isArray(act.files) ? act.files : [act.files])
        .map((n) => String(n).replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase());
      subset = state.fileBridge.filter(
        (f) =>
          want.includes(f.path.toLowerCase()) ||
          want.includes(f.path.split("/").pop().toLowerCase())
      );
      if (!subset.length)
        return "[TOOL RESULT] error: no attached file matches " +
          JSON.stringify(act.files) + " — attached: " +
          state.fileBridge.map((f) => f.path).join(", ");
    }
    const payloads = [];
    for (const f of subset)
      payloads.push({
        path: f.path,
        type: f.file.type || "text/plain",
        b64: abToB64(await f.file.arrayBuffer())
      });
    cmd = { action: "upload", target: act.target || act.selector || "", files: payloads };
  }
  const res = await callAgent(tabId, cmd);
  if (res.error) return "[TOOL RESULT] error: " + res.error;

  switch (act.action) {
    case "click":
    case "type":
    case "press":
    case "scroll":
      return `[TOOL RESULT] ${act.action} ok. Page title: ${res.title || state.attached.title}` +
        (res.notice ? ` (${res.notice})` : "");
    case "extract":
      return "[TOOL RESULT]\n" + String(res.text || "").slice(0, 3000);
    case "read":
      state.attached.snapshot = res;
      return "[TOOL RESULT]\n" + snapshotToContext(res).slice(0, 9000);
    case "navigate":
      return "[TOOL RESULT] navigated to " + res.url;
    case "upload":
      return "[TOOL RESULT] upload ok — " + (res.count || 0) +
        " file(s) handed to the page's file input" +
        (res.names && res.names.length ? ": " + res.names.join(", ") : "") +
        ". If the page now lists them, continue (commit message, confirm button).";
    default:
      return "[TOOL RESULT] unknown action: " + act.action;
  }
}

/* ═══════════════════════════ chat rendering ═══════════════════════════ */

function addMsgEl(kind, text) {
  const div = document.createElement("div");
  div.className = "msg msg-" + kind;
  div.innerHTML = kind === "user" || kind === "assistant" ? mdLite(text) : esc(text);
  $("chatLog").appendChild(div);
  $("chatLog").scrollTop = $("chatLog").scrollHeight;
  return div;
}

function renderHistory() {
  $("chatLog").innerHTML = "";
  if (!state.messages.length) {
    $("chatLog").innerHTML = `
      <div class="empty-state">
        <img src="../icons/icon128.png" alt="" class="empty-logo" />
        <h2>Sidebar Agent for Z.ai</h2>
        <p>Ask anything about <b>this page</b>, or tell the agent to click, fill or scroll. It will ask before acting.</p>
      </div>`;
    return;
  }
  for (const m of state.messages) {
    addMsgEl(m.role === "user" ? "user" : "assistant", m.content);
  }
}

function clearEmptyState() {
  const es = document.querySelector(".empty-state");
  if (es) es.remove();
}

/* ═══════════════════════════ send / agent loop ═══════════════════════════ */

async function send() {
  if (state.busy) return;
  const input = $("input");
  const text = input.value.trim();
  if (!text) return;
  if (!state.token) {
    toast("Connect to Z.ai first.");
    return;
  }

  input.value = "";
  input.style.height = "auto";
  clearEmptyState();
  addMsgEl("user", text);
  state.messages.push({ role: "user", content: text });

  state.pageNote = null;
  if (state.autoAttach) {
    const att = await attachPage();
    if (!att.ok) {
      state.pageNote = att.reason;
      addMsgEl("tool", "📎 Couldn't read the current page — " + att.reason + ".");
    }
  }

  state.busy = true;
  $("btnSend").disabled = true;
  $("btnStop").classList.remove("hidden");
  state.abort = new AbortController();

  let bubble = null;
  try {
    let steps = 0;
    let nudges = 0; // self-heal attempts for malformed action blocks
    let lastReply = "";
    while (steps < MAX_AGENT_STEPS) {
      steps++;
      const messages = buildLlmMessages();
      bubble = addMsgEl("assistant", "");
      bubble.classList.add("cursor-blink");
      let thinkEl = null;

      const { content, reasoning } = await streamCompletion({
        messages,
        // used by the WAF heal path when a full payload keeps getting blocked
        leanMessages: () => buildLlmMessages(true),
        chatId: state.chatId,
        signal: state.abort.signal,
        onDelta: (rDelta, cDelta) => {
          if (rDelta) {
            if (!thinkEl) {
              thinkEl = document.createElement("details");
              thinkEl.className = "msg msg-thinking";
              thinkEl.innerHTML = `<summary>💭 thinking…</summary><div class="think-body"></div>`;
              $("chatLog").insertBefore(thinkEl, bubble);
            }
            thinkEl.querySelector(".think-body").textContent += rDelta;
            thinkEl.querySelector("summary").textContent = "💭 thinking";
          }
          if (cDelta) {
            bubble._raw = (bubble._raw || "") + cDelta;
            bubble.innerHTML = mdLite(bubble._raw);
          }
          $("chatLog").scrollTop = $("chatLog").scrollHeight;
        }
      });

      bubble.classList.remove("cursor-blink");
      if (!bubble._raw) bubble._raw = content || "(empty reply)";
      bubble.innerHTML = mdLite(bubble._raw);
      if (reasoning && !thinkEl) {
        thinkEl = document.createElement("details");
        thinkEl.className = "msg msg-thinking";
        thinkEl.innerHTML = `<summary>💭 thinking</summary><div class="think-body">${esc(reasoning)}</div>`;
        $("chatLog").insertBefore(thinkEl, bubble);
      }

      state.messages.push({ role: "assistant", content });
      lastReply = content;

      const act = parseAction(content);
      if (!act) break; // plain answer — done
      if (act.action === "error") {
        console.warn("[Sidebar Agent] unparseable action block:", act.raw);
        if (nudges < 2 && !state.abort.signal.aborted) {
          nudges++;
          addMsgEl("tool", "🔁 The action block was malformed — asking the model to re-emit it as strict JSON (" + nudges + "/2)…");
          state.messages.push({
            role: "user",
            content:
              "[SYSTEM] Your previous reply contained an action block, but its JSON could not be parsed. " +
              "Re-send ONLY the next step as exactly ONE fenced block like:\n" +
              '```action\n{"action":"click","target":"e12"}\n```\n' +
              "Strict JSON rules: double quotes, no comments, no trailing commas, " +
              "no raw line breaks inside strings (use \\n), one block only, no prose after it."
          });
          continue;
        }
        addMsgEl("tool", "[unparseable action block — agent stopped] The model kept writing malformed JSON. Rephrase the task or try again.");
        break;
      }
      if (act.action === "done") {
        if (act.final && act.final !== content) {
          addMsgEl("assistant", act.final);
          state.messages.push({ role: "assistant", content: act.final });
        }
        break;
      }

      const result = await executeAction(act);
      addMsgEl("tool", result.length > 400 ? result.slice(0, 400) + " …" : result);
      state.messages.push({ role: "user", content: result });
    }
    if (steps >= MAX_AGENT_STEPS) {
      addMsgEl("assistant", "_Reached the step limit (10 actions). Ask me to continue if needed._");
    }
  } catch (e) {
    if (bubble && !bubble._raw) bubble.remove(); // drop the empty placeholder
    if (String(e.message || e).includes("abort")) {
      addMsgEl("tool", "[stopped by user]");
    } else {
      addMsgEl("error", "⚠ " + (e.message || e));
    }
  } finally {
    state.busy = false;
    $("btnSend").disabled = false;
    $("btnStop").classList.add("hidden");
    state.abort = null;
  }
}

function buildLlmMessages(lean = false) {
  const msgs = [{ role: "system", content: SYSTEM_PROMPT }];
  // priming pair — pins the browser-agent persona before any real history.
  // Kept even in lean (WAF-retry) mode: without it the model drifts back to
  // the plain-chat persona and starts claiming it "only has web search".
  msgs.push({ role: "user", content: "Mode check: what are you and what can you do on this page?" });
  msgs.push({
    role: "assistant",
    content:
      "I am the browser-automation agent in your side panel. My only tools are real ```action blocks — click / type / press / scroll / extract / navigate / upload / done — and the extension executes them in the active tab. I have no web_search or WebFetch and no shell. When you ask me to do something on the page, I act step by step; I never tell you to do it yourself and never expose my private reasoning."
  });
  if (state.attached && state.attached.snapshot) {
    if (lean) {
      // lean retry (WAF healing): a one-line page note instead of the full
      // snapshot — big YouTube-sized bodies are what trips the WAF rules
      msgs.push({
        role: "user",
        content:
          "[PAGE SNAPSHOT]\nURL: " + (state.attached.snapshot.url || "") +
          "\nTitle: " + (state.attached.snapshot.title || "") +
          "\n(full snapshot trimmed to keep this retry request small)"
      });
    } else {
      // user-role: GLM templates weight user turns above system turns
      msgs.push({ role: "user", content: snapshotToContext(state.attached.snapshot) });
    }
  } else if (state.pageNote) {
    msgs.push({
      role: "user",
      content:
        "[PAGE SNAPSHOT UNAVAILABLE] " + state.pageNote +
        " — the extension could not read the active tab. If the user asks " +
        "about the page, say exactly that and suggest opening a normal " +
        "website tab or reloading it (F5)."
    });
  }
  if (state.fileBridge && state.fileBridge.length) {
    msgs.push({ role: "user", content: fileBridgeContext(lean) });
  }
  // cap history to last 30 messages (8 in lean retries) + a per-turn
  // agent-mode reminder
  const hist = state.messages.slice(lean ? -8 : -30);
  const last = hist[hist.length - 1];
  if (last && last.role === "user" && !/^\[(TOOL RESULT|PAGE SNAPSHOT)/.test(last.content)) {
    hist[hist.length - 1] = {
      ...last,
      content:
        last.content +
        "\n\n(Agent mode reminder: to do anything on the page — click, type, press Enter, scroll, navigate, upload attached files — reply with an action block; the extension executes it for real. You have no other tools and must never say you do. Never tell the user to do it themselves.)"
    };
  }
  msgs.push(...hist);
  return msgs;
}

/* ═══════════════════════════ sessions ui ═══════════════════════════ */

async function renderSessions() {
  const list = $("sessionList");
  if (!state.token) {
    list.innerHTML = `<div class="muted small pad8">Click Connect first — sessions come from your chat.z.ai account.</div>`;
    return;
  }
  list.innerHTML = `<div class="muted small pad8">Loading…</div>`;
  try {
    const chats = await listChats();
    list.innerHTML = "";
    if (!chats.length) {
      list.innerHTML = `<div class="muted small pad8">No chats on the account yet.</div>`;
    }
    for (const c of chats) {
      const b = document.createElement("button");
      b.className = "session-item" + (c.id === state.chatId ? " active" : "");
      const d = new Date(c.updated_at || Date.now());
      b.innerHTML = `<span class="s-title">${esc(c.title)}</span>` +
        `<span class="s-date">${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>`;
      b.onclick = async () => {
        state.chatId = c.id;
        state.chatTitle = c.title;
        state.messages = await loadChatMessages(c.id);
        renderHistory();
        renderSessions();
        $("sessionsPanel").classList.add("hidden");
      };
      list.appendChild(b);
    }
  } catch (e) {
    list.innerHTML = `<div class="muted small pad8">Failed: ${esc(e.message)}</div>`;
  }
}

function newChat() {
  state.chatId = uuid();
  state.chatTitle = "New chat";
  state.messages = [];
  renderHistory();
  $("sessionsPanel").classList.add("hidden");
}

/* ═══════════════════════════ settings ═══════════════════════════ */

function saveSettings() {
  localStorage.setItem(
    "zaiPanelSettings",
    JSON.stringify({
      model: state.model,
      confirmMode: state.confirmMode,
      autoAttach: state.autoAttach
    })
  );
}

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("zaiPanelSettings") || "{}");
    if (s.model) state.model = s.model;
    if (typeof s.confirmMode === "boolean") state.confirmMode = s.confirmMode;
    if (typeof s.autoAttach === "boolean") state.autoAttach = s.autoAttach;
  } catch {}
  $("confirmMode").checked = state.confirmMode;
  $("autoAttach").checked = state.autoAttach;
  $("modelCustom").value = "";
}

/* ═══════════════════════════ wiring ═══════════════════════════ */

document.addEventListener("DOMContentLoaded", async () => {
  loadSettings();

  $("btnConnect").onclick = connect;
  $("btnSessions").onclick = () => {
    $("sessionsPanel").classList.toggle("hidden");
    $("settingsPanel").classList.add("hidden");
    if (!$("sessionsPanel").classList.contains("hidden")) renderSessions();
  };
  $("btnSettings").onclick = () => {
    $("settingsPanel").classList.toggle("hidden");
    $("sessionsPanel").classList.add("hidden");
  };
  $("btnNewChat").onclick = newChat;
  $("btnRefreshModels").onclick = refreshModels;
  $("btnDetach").onclick = detachPage;
  $("btnAttach").onclick = async () => {
    const att = await attachPage(true);
    if (att.ok) toast("📄 Attached: " + att.attached.title);
    else toast("📎 " + att.reason, 6000);
  };

  // 📎 file bridge — local files / project folder for upload & publish tasks
  $("btnFiles").onclick = () => $("fileMenu").classList.toggle("hidden");
  $("btnFiles").oncontextmenu = (e) => {
    e.preventDefault();
    if (state.fileBridge.length) {
      state.fileBridge = [];
      updateAttachBadge();
      toast("📎 File bridge cleared.");
    }
  };
  $("btnPickFolder").onclick = () => {
    $("fileMenu").classList.add("hidden");
    $("filePickFolder").click();
  };
  $("btnPickFiles").onclick = () => {
    $("fileMenu").classList.add("hidden");
    $("filePickFiles").click();
  };
  $("filePickFolder").onchange = (e) => {
    attachFiles(e.target.files);
    e.target.value = "";
  };
  $("filePickFiles").onchange = (e) => {
    attachFiles(e.target.files);
    e.target.value = "";
  };
  document.addEventListener("click", (e) => {
    if (
      !$("fileMenu").classList.contains("hidden") &&
      !$("fileMenu").contains(e.target) &&
      e.target !== $("btnFiles")
    )
      $("fileMenu").classList.add("hidden");
  });

  // if the user switches tabs or the page navigates, drop the stale
  // attachment so the next message re-reads the right page
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    if (state.attached && state.attached.tabId !== tabId) {
      state.attached = null;
      $("pageChip").classList.add("hidden");
    }
  });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (state.attached && state.attached.tabId === tabId && info.url) {
      state.attached = null;
      $("pageChip").classList.add("hidden");
    }
  });
  $("modelSelect").onchange = syncModelFromUi;
  $("modelCustom").oninput = syncModelFromUi;
  $("confirmMode").onchange = (e) => {
    state.confirmMode = e.target.checked;
    saveSettings();
  };
  $("autoAttach").onchange = (e) => {
    state.autoAttach = e.target.checked;
    saveSettings();
  };
  $("btnSaveToken").onclick = () => {
    const t = $("manualToken").value.trim();
    if (t) {
      localStorage.setItem("zaiManualToken", t);
      toast("Token saved. Click Connect to use it.");
    }
  };

  // privacy / data controls (matches the published privacy policy)
  $("btnDisconnect").onclick = () => {
    state.token = "";
    state.userId = "";
    state.userName = "";
    state.chatId = uuid();
    state.chatTitle = "New chat";
    state.messages = [];
    state.attached = null;
    state.fileBridge = [];
    $("pageChip").classList.add("hidden");
    localStorage.setItem("zaiManualToken", "");
    renderHistory();
    updateAttachBadge();
    setConn("Not connected", "conn-off");
    toast("Disconnected — the saved Z.ai token was removed from this browser.");
  };
  $("btnClearChat").onclick = () => {
    state.messages = [];
    renderHistory();
    toast("Panel chat history cleared.");
  };

  $("btnSend").onclick = send;
  $("btnStop").onclick = () => state.abort && state.abort.abort();
  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  $("input").addEventListener("input", (e) => {
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
  });

  // restore settings + refresh models silently
  ensureFeVersion();
  await refreshModels();
  const saved = JSON.parse(localStorage.getItem("zaiPanelSettings") || "{}");
  if (saved.model && [...$("modelSelect").options].some((o) => o.value === saved.model)) {
    $("modelSelect").value = saved.model;
  } else if (saved.model) {
    $("modelCustom").value = saved.model;
  }
  syncModelFromUi();

  // auto-reconnect with the last saved token
  const manual = (localStorage.getItem("zaiManualToken") || "").trim();
  if (manual) connect();
});
