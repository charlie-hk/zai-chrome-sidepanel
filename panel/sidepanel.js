// Z.ai Sidepanel Agent — panel logic
// Talks to the official Z.ai API (api.z.ai) with the user's own API key, streams
// SSE completions, and drives an on-page agent (read/click/type/scroll).

"use strict";

// build marker — verify in DevTools console of the side panel
console.log("[Sidebar Agent] build 1.0.36 - official API only; fewer and smaller requests per task.");

/* ═══════════════════════════ constants ═══════════════════════════ */

// Official Z.ai Open Platform (OpenAI-style) endpoint. Used when the user saves an API key:
// plain Bearer auth, a system prompt that is honoured, no captcha / signature / WAF dance.
const API_BASE = "https://api.z.ai/api/paas/v4";
const API_KEY_URL = "https://z.ai/manage-apikey/apikey-list";
// Flash ids are taken from third-party reports that Z.ai lists them at $0; the exact ids are unverified,
// the "Custom model id" box in Settings overrides them.
// Listed as $0 on docs.z.ai/guides/overview/pricing (checked 2026-11-22 via search results). A new account
// has no balance, so the paid flagship models fail with HTTP 429 "Insufficient balance".
const FREE_MODELS = ["glm-4.7-flash", "glm-4.5-flash"];
const API_MODELS = [...FREE_MODELS, "glm-5.3-flash", "glm-5.3", "glm-5.2", "glm-5.1"];
const API_DEFAULT_MODEL = FREE_MODELS[0];
// "temporarily overloaded" (HTTP 429) is a shared-capacity answer, not a bug: wait longer, pace requests,
// and alternate between the two free models. (The 1 request/second figure for free Flash models comes from a
// third-party list and is unverified; it is only used to space requests.)
const API_MAX_ATTEMPTS = 6;
const API_BACKOFF_MS = [2000, 4000, 8000, 12000, 16000];
const API_MIN_GAP_MS = 1200;
let apiLastStart = 0;

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error("aborted by user"));
    const t = setTimeout(() => { if (signal) signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new Error("aborted by user")); };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}
const API_IDLE_MS = 60000; // abort a stream that goes silent instead of hanging forever
const MAX_AGENT_STEPS = 24; // a real LinkedIn post needs ~15 steps: open, read, click, upload, type, post, verify

// chat.z.ai's own backend sometimes streams its built-in browser tools into
// assistant content as <glm_block>…</glm_block> JSON. In this side panel
// those native tools are NOT wired to the user's tab: their result is always
// empty and they never act. We strip that markup from the chat and promote
// any real call into one of OUR action blocks (parseNativeMcpAction below).
const STRIP_GLM_RE = /<glm_block[\s\S]*?<\/glm_block>/gi;

// Used only to catch a model that claims it acted without executing anything.
const ACTION_CLAIM_RE = /\b(?:i\s+(?:have\s+)?(?:clicked|typed|submitted|sent|navigated|opened|uploaded|played|searched|filled|pressed|scrolled))\b|انجام\s*دادم|کلیک\s*کردم|تایپ\s*کردم|ارسال\s*کردم|باز\s*کردم|جستجو\s*کردم|آپلود\s*کردم|فشار\s*دادم/i;

// Catch the opposite failure: the model denying it has browser control at all
// ("I only have web search / no browser automation / I cannot click"). GLM
// drifts back to this when it sees its native tool names, so we correct it.
const CAPABILITY_DENIAL_RE = new RegExp([
  // (A) an inability verb tied to a browser action: "I cannot click", "unable to type"
  String.raw`\b(?:cannot|can'?t|can\s+not|unable\s+to|not\s+able\s+to)\s+(?:\w+\s+){0,2}?(?:click|type|typing|interact|control|access|browse|navigate|upload|screenshot|capture)\b`,
  // (B) "I don't have a click/type tool", "I don't have access"
  String.raw`\b(?:don'?t|do\s+not|does\s+not)\s+have\s+(?:a|an|the|any)?\s*(?:direct\s+)?(?:browser\s+)?(?:automation|tools?|ability|access|control|click|typing|type|screenshot)\b`,
  // (C) "no browser automation", "no tools"
  String.raw`\bno\s+(?:direct\s+)?(?:browser\s+)?(?:automation|tools?)\b`,
  // (D) "I can only read / search"
  // native web-fetch drift: an empty fetch is not a page read
  String.raw`web\s*fetch[^.!?\n]{0,60}?(?:empty|fail)`,
  String.raw`empty\s+(?:web\s*)?content`,
  // Persian
  String.raw`(?:نمیتونم|نمی\s*تونم|نمیتوانم|نمی\s*توانم)[^.!?\n]{0,30}(?:کلیک|تایپ|وارد|باز|دسترس|اسکرین|آپلود|مرورگر|سایت|صفحه)`,
  String.raw`نمی\s*شه\s*(?:کلیک|تایپ)`,
  String.raw`دسترسی\s*(?:به\s*\S+\s*)?ندارم`,
  String.raw`ابزار(?:ی)?[^.!?\n]{0,25}ندارم`,
  String.raw`امکان\s*(?:کلیک|تایپ|اجرا)\s*ندارم`,
  String.raw`محتوای\s*وب\s*خالی|وب\s*فچ`,
  String.raw`جستجوی\s*وب|اتوماسیون\s*مرورگر|فقط\s*(?:جستجو|خواندن)`
].join("|"), "i");

const SYSTEM_PROMPT = `You are Z.ai Sidepanel Agent — a browser-automation agent in a Chrome side panel next to the user's active tab. You CONTROL that tab: the extension really executes your action blocks (this is exactly what the user installed you for; risky steps are shown to the user for approval first). You are NOT the plain chat.z.ai assistant.

TOOL REALITY — READ THIS FIRST, IT OVERRIDES YOUR TRAINING: you are running INSIDE a browser extension, not on the chat.z.ai website. The fenced \`\`\`action blocks listed below are the ONLY interface you have, and the extension really executes them in the user's tab. Clicking, typing, pressing keys, scrolling, navigating and uploading via these blocks WORK — that is the entire purpose of this session. Any instinct that you are a plain web assistant with "web search" or "page reader" tools is WRONG for this session: do not describe your tools, do not say you cannot control the browser, do not say you lack automation. If a task needs the page, USE AN ACTION BLOCK — never narrate your capabilities. Everything you output is shown to the user verbatim — never expose private deliberation or capability inventories. Your visible reply is either a one-line plan + one action block, or the final answer in the user's language.\n\nNEVER emit <glm_block> or call mcp_server tools (action_click, action_type, action_press, …) — those are not connected to this tab, return an empty result, get stripped from the chat and count as FAILED steps. NEVER call a web-fetch / web-search tool either: it returns EMPTY in this session (you have already seen "web content empty") and wastes a step. To read ANY page — including one the user names — use {"action":"navigate","url":...} to open it in the tab, then {"action":"read"} for its content. A fenced \`\`\`action block is the ONLY way to act. WRITE ACTIONS AS A PROPER FENCED BLOCK WITH JSON — never as loose prose like "action navigate url: …" or "action screenshot"; text like that is not an action block.\n\nThe user's active browser tab arrives as a [PAGE SNAPSHOT] message — it is not a screenshot, it is the live DOM of that tab. "this page" always means that page; ground every answer about it in the snapshot. If you instead see [PAGE SNAPSHOT UNAVAILABLE], the extension could not read the tab: say exactly that and suggest opening a normal website tab (or reloading it with F5). Interactive elements carry stable ids like "e12" — use those ids as targets.

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
- {"action":"navigate","url":"https://…"}                    — open a URL in the active tab (works even from the New Tab page) and wait for it to load; the result already contains the loaded page, so you can answer from it or click on. Fastest way to search (e.g. YouTube: https://www.youtube.com/results?search_query=…)
- {"action":"screenshot"}                                    — CAPTURE A REAL IMAGE of the visible page. The image is shown in the chat and attached to the 📎 bridge as screenshot-<time>.png. To place it into a post (e.g. LinkedIn image), next send {"action":"upload","files":["screenshot-<time>.png"],"target":"input[type=file]"}. Chrome cannot capture browser UI / chrome:// pages / DevTools — use a normal website tab.
- {"action":"upload","files":"all"}                          — feed the 📎-attached files into the current page's file input; "files" may also be an array of paths like ["manifest.json","panel/sidepanel.js"]; optional "target" = CSS selector for the file input
- {"action":"done","final":"<message for the user>"}         — you are finished; deliver the final answer

Rules:
- When the user asks you to DO something on the page (open, play, search, fill, click, upload, publish), you must act with action blocks until it is done. NEVER reply with instructions for the user to do it themselves, and NEVER claim you cannot click/type/navigate.
- After each action you will receive a [TOOL RESULT] message. Continue step by step until you can answer.
- TRUTH RULE (absolute): a [TOOL RESULT] starting with "error:" means the action DID NOT RUN — never claim it ran, never say a message was typed or sent, never invent how the page reacted. State the failure plainly, then fix it (send {"action":"read"} for fresh ids and retry). A "type confirmed" result quotes the field's new text — that is the only proof typing worked; a press result says "input cleared after Enter — message submitted" only when the page really submitted. Until you see that exact confirmation, the message is NOT sent — and if retries keep failing, tell the user exactly that instead of pretending success.
- Stale ids: pages re-render after every click/type — an id from an older snapshot may be gone. On "element not found" the [TOOL RESULT] carries a fresh id list: pick from it immediately (or send {"action":"read"}).
- "target" accepts a snapshot id (e12), a CSS selector like a[href*='name'], OR the visible label of the element such as "Start a post". Always put the value in "target"; "ref", "id" and "element" are accepted aliases but "target" is the field to use. If two elements share a label the action fails with the candidate ids — pick one id and resend. "extract" takes a CSS "query" ("selector" also works) and returns ALL matches; navigate accepts relative URLs like /repo-name.
- Only one action block per reply. You may also write a short plan before the block.
- When no action is needed, just answer in plain text (markdown allowed).
- LANGUAGE: always reply in the language the user writes in (Persian → Persian, English → English, etc.). Your very first reply after the user connects must include exactly this line: "Now you can chat in your language".
- Never submit payments, enter passwords, delete data or send messages on the user's behalf unless the user explicitly asked for exactly that.
- If the snapshot lacks information you need, use "extract" or "read" rather than guessing. BUT if the snapshot (or an earlier [TOOL RESULT]) already contains what you need, answer directly with NO action at all — every action is visible to the user and slows the reply. Do not re-read a page you have already read unless it visibly changed. Prefer the fewest possible steps, and deliver the final answer (plain text or {"action":"done"}) as soon as the goal is met. If you did not actually execute an action block in this turn, never claim you clicked, typed, sent, opened or changed anything — say plainly that you did not.

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
  token: "", // "api-key" once connected (placeholder: send() only checks that a credential exists)
  apiKey: "",
  userName: "",
  model: API_DEFAULT_MODEL,
  confirmMode: true,
  autoAttach: true,
  showStatus: true, // one updating line (not a wall) — user sees it is retrying, not hung
  chatId: "",
  chatTitle: "New chat",
  messages: [], // {role, content}
  attached: null, // {tabId, url, title, snapshot}
  pageNote: null, // why no page snapshot could be attached this turn
  busy: false,
  abort: null,
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

/* ── native MCP tool-call hygiene ─────────────────────────────────────── */
function stripGlmBlocks(s) {
  const src = String(s == null ? "" : s);
  let out = src.replace(STRIP_GLM_RE, "").replace(/<\/?glm_block[^>]*>/gi, "");
  // Some streams emit only the closing tag plus the result object.
  if (/mcp_server|display_result|"type"\s*:\s*"mcp"/i.test(src)) {
    out = out
      .split("\n")
      .filter(
        (l) =>
          !/"(?:mcp_server|display_result|is_error|result|status|duration|type)"\s*:/i.test(l) &&
          !/^\s*[}\],]+\s*$/.test(l)
      )
      .join("\n");
  }
  return out.replace(/^\s*[\u200b-\u200d\ufeff]+\s*$/gm, "").trim();
}

// Turn a native <glm_block> mcp_server call into a real extension action.
// Result-only blocks (no usable parameters) are ignored.
function parseNativeMcpAction(text) {
  let src = String(text || "");
  // Some streams deliver only the result JSON plus a stray closing tag (no
  // opening <glm_block>). Wrap it so the same parser handles that shape.
  if (!/<glm_block/i.test(src) && /"mcp_server"\s*:/i.test(src)) {
    src = "<glm_block>" + src + "</glm_block>";
  }
  const re = /<glm_block[^>]*>([\s\S]*?)<\/glm_block>/gi;
  let m;
  while ((m = re.exec(src))) {
    const inner = m[1].trim();
    let obj = null;
    try { obj = JSON.parse(inner); } catch {}
    if (!obj || typeof obj !== "object") obj = tryParseActionJSON(inner);
    if (!obj || typeof obj !== "object") continue;
    const srv = obj.mcp_server || obj.server || {};
    const name = String(srv.name || obj.name || obj.tool || obj.tool_name || "");
    let args = srv.arguments || srv.args || obj.arguments || obj.args || {};
    if (typeof args === "string") {
      const parsed = tryParseActionJSON(args);
      args = parsed && typeof parsed === "object" ? parsed : {};
    }
    // Observed malformed shape: name = "action_click\ntarget=e37</arg_value>"
    if (!Object.keys(args).length && /action_/i.test(name)) {
      const kv = {};
      const cleaned = name.replace(/<\/?arg_value>/gi, " ");
      const kre = /([A-Za-z_][\w-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s]+)/g;
      let km;
      while ((km = kre.exec(cleaned))) kv[km[1]] = km[2].replace(/^["']|["']$/g, "");
      args = kv;
    }
    const am = name.match(/action_([A-Za-z_]+)/i);
    if (!am) continue;
    const action = am[1].toLowerCase();
    if (!["click","type","press","scroll","extract","read","navigate","upload","done"].includes(action)) continue;
    const out = { action };
    for (const k of ["target","selector","element","text","key","direction","query","css","url","link","href","files"])
      if (args[k] !== undefined) out[k] = args[k];
    if (action === "click" && !out.target && !out.selector && !out.element) continue;
    if (action === "type" && typeof out.text !== "string") continue;
    if (action === "navigate" && !out.url && !out.link && !out.href) continue;
    return out;
  }
  return null;
}

// Retry/captcha/WAF chatter becomes ONE updating line (or is hidden).
let liveStatusEl = null;
function setStatus(text) {
  if (!state.showStatus) { console.debug("[Sidebar Agent] " + text); return; }
  try {
    if (!liveStatusEl || !liveStatusEl.isConnected) {
      liveStatusEl = addMsgEl("tool", text);
    } else {
      liveStatusEl.textContent = text;
      $("chatLog").scrollTop = $("chatLog").scrollHeight;
    }
  } catch {}
}
function clearStatus() {
  if (liveStatusEl && liveStatusEl.isConnected) liveStatusEl.remove();
  liveStatusEl = null;
}

function toast(msg, ms = 3500) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), ms);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abortedOpt = (opts) => !!(opts.signal && opts.signal.aborted);

/* ── official API transport ───────────────────────────────────────────── */

function isBalanceError(status, msg) {
  return status === 429 && /insufficient balance|no resource package|recharge/i.test(String(msg || ""));
}

function apiErrorText(status, bodyText) {
  let msg = "";
  try {
    const j = JSON.parse(bodyText);
    msg = (j.error && (j.error.message || j.error.code)) || j.message || "";
  } catch {}
  if (status === 401 || status === 403)
    return "The API key was rejected (HTTP " + status + "). Check it in Settings → API key." + (msg ? " Server said: " + msg : "");
  if (isBalanceError(status, msg))
    return "Your Z.ai account has no balance for this model. Free models (" + FREE_MODELS.join(", ") + ") need none.";
  if (status === 429)
    return "Rate limit or balance problem (HTTP 429)." + (msg ? " Server said: " + msg : " Wait a moment or check your balance on z.ai. If the balance is empty, pick a free Flash model in Settings.");
  return "API error HTTP " + status + (msg ? ": " + msg : "");
}

// Parses one SSE text chunk stream into {reasoning, content} deltas. Exported for tests.
function createSseParser(onEvent) {
  let buf = "";
  return (chunk, flush = false) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = flush ? "" : lines.pop();
    for (const line of flush ? lines.concat(buf ? [buf] : []) : lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (!data) continue;
      onEvent(data);
    }
  };
}

async function streamCompletionApi({ messages, onDelta, signal }) {
  if (!state.apiKey) throw new Error("No API key saved. Open Settings → API key.");
  const body = {
    model: state.model || API_DEFAULT_MODEL,
    stream: true,
    messages: messages.map((m) => ({ role: m.role, content: m.content }))
  };
  let lastErr = null;
  for (let attempt = 1; attempt <= API_MAX_ATTEMPTS; attempt++) {
    if (signal && signal.aborted) throw new Error("aborted by user");
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    let idle = setTimeout(() => ctl.abort("idle"), API_IDLE_MS);
    const bump = () => { clearTimeout(idle); idle = setTimeout(() => ctl.abort("idle"), API_IDLE_MS); };
    let emitted = false;
    try {
      const gap = apiLastStart + API_MIN_GAP_MS - Date.now();
      if (gap > 0) await abortableSleep(gap, signal); // pace consecutive agent steps
      apiLastStart = Date.now();
      const res = await fetch(API_BASE + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + state.apiKey
        },
        body: JSON.stringify(body),
        signal: ctl.signal
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        const err = new Error(apiErrorText(res.status, txt));
        let m = "";
        try { const j = JSON.parse(txt); m = (j.error && (j.error.message || j.error.code)) || j.message || ""; } catch {}
        err.balance = isBalanceError(res.status, m);
        err.retryable = !err.balance && (res.status === 429 || res.status >= 500);
        err.status = res.status;
        const ra = Number(res.headers && res.headers.get && res.headers.get("retry-after"));
        if (ra > 0 && ra < 120) err.retryAfterMs = ra * 1000;
        throw err;
      }
      let content = "", reasoning = "", failure = null;
      const feed = createSseParser((data) => {
        if (data === "[DONE]") return;
        let j;
        try { j = JSON.parse(data); } catch { return; }
        if (j.error) { failure = j.error.message || JSON.stringify(j.error); return; }
        const d = j.choices && j.choices[0] && j.choices[0].delta;
        if (!d) return;
        const r = d.reasoning_content || "";
        const c = d.content || "";
        if (r) reasoning += r;
        if (c) content += c;
        if (r || c) { emitted = true; if (onDelta) onDelta(r, c); }
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bump();
        feed(dec.decode(value, { stream: true }));
      }
      feed("", true);
      if (failure) throw new Error("API stream error: " + failure);
      return { content, reasoning };
    } catch (e) {
      const aborted = signal && signal.aborted;
      if (aborted) throw new Error("aborted by user");
      if (ctl.signal.aborted) e = new Error("No data from the API for " + API_IDLE_MS / 1000 + " s — request cancelled. Send the message again.");
      if (e.balance && !FREE_MODELS.includes(body.model)) {
        // empty balance: continue on a free model instead of stopping, and remember the choice
        const free = FREE_MODELS[0];
        setStatus("No balance for " + body.model + " — switching to the free model " + free);
        body.model = free;
        state.model = free;
        try { $("modelSelect").value = free; $("modelCustom").value = ""; saveSettings(); } catch {}
        attempt--; // this was not a real retry
        continue;
      }
      lastErr = e;
      const retryable = !emitted && (e.retryable || /Failed to fetch|NetworkError|network/i.test(String(e.message)));
      if (!retryable) throw e;
      if (attempt === API_MAX_ATTEMPTS) {
        if (e.status === 429 || e.status >= 500)
          throw new Error("Z.ai is overloaded right now (HTTP " + e.status + ", " + API_MAX_ATTEMPTS +
            " tries). That is shared capacity, not your key. Try again in a minute, or pick a paid model in Settings.");
        throw e;
      }
      // second failure in a row on a free model: try the other free model for this request
      let switched = "";
      if (attempt >= 2 && FREE_MODELS.includes(body.model) && (e.status === 429 || e.status >= 500)) {
        body.model = FREE_MODELS[(FREE_MODELS.indexOf(body.model) + 1) % FREE_MODELS.length];
        switched = " — trying " + body.model;
      }
      const base = e.retryAfterMs != null ? e.retryAfterMs : API_BACKOFF_MS[Math.min(attempt - 1, API_BACKOFF_MS.length - 1)];
      const delay = base + Math.floor(Math.random() * 500);
      setStatus("Z.ai is busy (" + (e.status ? "HTTP " + e.status : "network") + "), retrying in " +
        Math.round(delay / 1000) + " s (" + attempt + "/" + (API_MAX_ATTEMPTS - 1) + ")" + switched);
      await abortableSleep(delay, signal);
    } finally {
      clearTimeout(idle);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }
  throw lastErr || new Error("API request failed");
}

async function streamCompletion(opts) {
  return streamCompletionApi(opts);
}

async function refreshModels() {
  const sel = $("modelSelect");
  sel.innerHTML = API_MODELS.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join("");
  if (localStorage.getItem("zaiApiModelChosen") !== "1") state.model = API_DEFAULT_MODEL;
  sel.value = API_MODELS.includes(state.model) ? state.model : API_DEFAULT_MODEL;
  if ($("modelCustom").value.trim()) sel.value = "custom";
  syncModelFromUi();
}

function syncModelFromUi() {
  const custom = $("modelCustom").value.trim();
  state.model = custom || $("modelSelect").value || state.model;
  saveSettings();
}

/* ── connect ──────────────────────────────────────────────── */

const KEY_STAGE_HELP = {
  not_logged_in: "Sign in to Z.ai on the page that just opened, then press Connect again.",
  no_create_button: "I could not find the “create key” button (the page may have changed).",
  key_not_found: "The key did not appear on the page (a verification step may be waiting for you).",
  inject_failed: "I could not run on that page.",
  exception: "Something went wrong on the page."
};

// With the user's approval: open THEIR Z.ai key page, press its "create key" button, read the new
// key from the page and keep it in this browser. Returns true when a key was saved.
async function autoCreateApiKey() {
  const approved = await approveAction(
    "Allow Sidebar Agent to set up your key?\n\n" +
    "• opens your Z.ai API-keys page (z.ai/manage-apikey)\n" +
    "• presses “Create API Key” in your own account\n" +
    "• copies the new key and keeps it in this browser only\n\n" +
    "The key is sent only to api.z.ai. You can delete it any time on that page."
  );
  if (!approved) return false;
  setConn("Creating your key…", "conn-off");
  let tab;
  try {
    tab = await chrome.tabs.create({ url: API_KEY_URL, active: true });
    await waitForTabLoad(tab.id, 25000);
    tab = await chrome.tabs.get(tab.id);
  } catch (e) {
    toast("Could not open the key page: " + (e && e.message ? e.message : e));
    return false;
  }
  let host = "";
  try { host = new URL(tab.url || "").hostname; } catch {}
  let res;
  if (host !== "z.ai" && !host.endsWith(".z.ai")) {
    res = { ok: false, stage: "not_logged_in" }; // redirected away from the key page: login screen
  } else {
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, func: zaiKeyCreator, args: ["Sidebar Agent"]
      });
      res = (r && r.result) || { ok: false, stage: "exception" };
    } catch (e) {
      res = { ok: false, stage: "inject_failed" };
    }
  }
  if (res.ok && res.key) {
    localStorage.setItem("zaiApiKey", res.key);
    res.key = "";
    return true;
  }
  toast((KEY_STAGE_HELP[res.stage] || KEY_STAGE_HELP.exception) +
    (res.stage === "not_logged_in" ? "" : " Create a key on that page and paste it in Settings → Advanced."), 12000);
  return false;
}

async function connect() {
  const apiKey = (localStorage.getItem("zaiApiKey") || "").trim();
  if (!apiKey) {
    state.apiKey = ""; state.token = "";
    if (await autoCreateApiKey()) return connect(); // key saved: reconnect through the normal path
    setConn("Not connected", "conn-off");
    return;
  }
  state.apiKey = apiKey;
  state.token = "api-key";
  state.userName = "API key";
  await refreshModels();
  setConn("Connected: official API (key)", "conn-on");
  toast("Using your Z.ai API key ✔");
  addMsgEl("tool", "Now you can chat in your language.");
}

function setConn(text, cls) {
  const el = $("connStatus");
  el.textContent = text;
  el.className = "conn " + cls;
}

/* ═══════════════════════════ page agent ═══════════════════════════ */

// Bound a promise so a silent tab cannot freeze the whole panel.
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

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

function snapshotToContext(snap, maxText = 4000, maxEls = 60) {
  const elems = (snap.elements || [])
    .slice(0, maxEls)
    .map((e) => `- [${e.id}] ${e.desc}`)
    .join("\n");
  const sel = String(snap.selection || "").trim();
  return (
    `[PAGE SNAPSHOT]\nURL: ${snap.url}\nTitle: ${snap.title}\n` +
    (sel ? `TEXT THE USER HAD SELECTED:\n"""\n${sel.slice(0, 1500)}\n"""\n` : "") +
    `VISIBLE TEXT (trimmed):\n"""\n${(snap.text || "").slice(0, maxText)}\n"""\n` +
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

// Turn a data: URL from captureVisibleTab into a real File so it can be fed
// to any page's <input type=file> (e.g. the image box of a LinkedIn post).
function dataUrlToFile(dataUrl, name) {
  const parts = String(dataUrl).split(",");
  const meta = parts[0] || "";
  const b64 = parts[1] || "";
  const mime = (meta.match(/data:([^;]+)/) || [])[1] || "image/png";
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new File([u8], name, { type: mime });
}

// Capture the visible area of the attached (active) tab as a PNG data URL.
// The tab is re-checked before and after the capture: captureVisibleTab grabs
// whatever is on screen, so a tab switch mid-approval would otherwise attach a
// screenshot of the wrong page to the post.
// Captures the tab the user is looking at RIGHT NOW. The old version compared the tab URL with
// the URL of the last snapshot, so after a navigate (or any SPA route change) it threw
// "the tab has changed" and the model reported that it could not take screenshots.
async function captureScreenshot() {
  const tab = await activeTab();
  if (!tab || !tab.id) throw new Error("No active tab to capture.");
  const url = tab.url || "";
  const blocked = friendlyAttachReason(url);
  if (blocked) throw new Error("Cannot capture this tab: " + blocked + ".");
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const [now] = await chrome.tabs.query({ windowId: tab.windowId, active: true });
  if (!now || now.id !== tab.id || now.url !== url)
    throw new Error("The tab changed during the capture, so the image was discarded. Try again.");
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(dataUrl || ""))
    throw new Error("Chrome returned no PNG image.");
  return dataUrl;
}

function screenshotError(error) {
  const raw = error && error.message ? error.message : String(error);
  const hint = /permission|cannot access|not allowed/i.test(raw)
    ? " Chrome refused the capture: use a normal http(s) tab that is visible in this window (not a browser page, the Web Store, or a tab with DevTools open)."
    : "";
  return "Screenshot failed — " + raw + hint;
}

// Polls the tab until it finished loading (status "complete"), with a hard limit.
async function waitForTabLoad(tabId, limitMs) {
  const t0 = Date.now();
  let sawLoading = false;
  while (Date.now() - t0 < limitMs) {
    await sleep(250);
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return; }
    if (tab.status === "loading") sawLoading = true;
    if (tab.status === "complete" && (sawLoading || Date.now() - t0 > 2500)) break;
  }
  await sleep(500); // let single-page apps paint their first view
}

// navigate is done by the PANEL through chrome.tabs.update. It used to run inside the page
// (location.href) and needed an attachable page first, so it failed on the New Tab page and
// never waited for the load; the next read/screenshot then hit a dead or stale page.
async function panelNavigate(act) {
  const raw = String(act.url || act.link || act.href || "").trim();
  if (!raw) return "[TOOL RESULT] error: navigate requires a URL";
  const tab = await activeTab();
  if (!tab || !tab.id) return "[TOOL RESULT] error: no active tab found";
  let url;
  try {
    url = new URL(raw, /^https?:/i.test(tab.url || "") ? tab.url : undefined).href;
  } catch {
    return "[TOOL RESULT] error: navigate needs a full http(s) URL (got: " + raw + ")";
  }
  if (!/^https?:/i.test(url))
    return "[TOOL RESULT] error: navigate only supports http(s) URLs (got: " + url + ")";
  if (state.confirmMode) {
    const ok = await approveAction(JSON.stringify({ action: "navigate", url }, null, 2));
    if (!ok) return "[TOOL RESULT] skipped by user";
  }
  try {
    await chrome.tabs.update(tab.id, { url });
    await waitForTabLoad(tab.id, 20000);
  } catch (e) {
    return "[TOOL RESULT] error: navigation failed — " + (e && e.message ? e.message : e);
  }
  state.attached = null;
  $("pageChip").classList.add("hidden");
  const at = await attachPage(true);
  if (!at.ok)
    return "[TOOL RESULT] navigated to " + url + ", but the page cannot be read: " + at.reason;
  return "[TOOL RESULT] navigated to " + at.attached.url + "\n" +
    snapshotToContext(at.attached.snapshot, 3000, 50);
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

// GLM sometimes writes actions as loose prose instead of a fenced JSON block,
// e.g. "action navigate url: https://x.com/" or "action screenshot بگیر" or
// "اسکرینشات بگیر". Recognise those too so the step actually runs instead of
// being shown as dead text. The last such command in the reply wins.
function parseLooseAction(text) {
  const src = String(text || "");
  const re =
    /(?:^|[^A-Za-z0-9])action\s+(navigate|screenshot|click|type|press|scroll|extract|read|upload|done)\b([^\n]*)/gi;
  let m, last = null;
  while ((m = re.exec(src))) {
    if (last) break; // one action per turn — take the FIRST runnable one
    const name = m[1].toLowerCase();
    const tail = m[2] || "";
    const act = { action: name };
    if (name === "navigate") {
      const u = tail.match(/https?:\/\/[^\s"'<>،,)+]+/i);
      if (u) act.url = u[0];
      else return null; // a navigate with no URL is not runnable
    } else if (name === "click" || name === "type" || name === "press" || name === "upload") {
      const t = tail.match(/(?:target|element)\s*[:=]\s*([^\s،,]+)/i) ||
        tail.match(/\b(e\d+)\b/i);
      if (t) act.target = t[1];
      const tx = tail.match(/text\s*[:=]\s*["']?([^"'\n]+?)["']?(?:\s|$)/i);
      if (tx) act.text = tx[1].trim();
      const k = tail.match(/key\s*[:=]\s*([A-Za-z]+)/i);
      if (k) act.key = k[1];
    } else if (name === "scroll") {
      const d = tail.match(/\b(up|down|top|bottom)\b/i);
      if (d) act.direction = d[1].toLowerCase();
    } else if (name === "extract") {
      const q = tail.match(/query\s*[:=]\s*["']?([^"'\n]+)/i);
      if (q) act.query = q[1].trim();
    }
    last = act;
  }
  // Persian bare screenshot instruction with no "action" word at all.
  if (!last && /اسکرین\s*شات\s*(?:بگیر|بگیریم|بگیرید)/i.test(src)) {
    last = { action: "screenshot" };
  }
  return last;
}

// GLM almost never sends "target". It sends ref / id / elementId, or a human
// label ("Start a post button"). Fold every alias into one canonical action so
// the agent, the approval dialog and the chat history all agree on the target.
const TARGET_ALIASES = ["ref", "refId", "ref_id", "id", "elementId", "element_id", "eid", "targetId", "target_id", "locator", "node"];

function normalizeAction(act) {
  if (!act || typeof act !== "object") return act;
  const a = { ...act };
  const usable = (v) => typeof v === "string" && v.trim();
  if (!usable(a.target)) {
    for (const key of TARGET_ALIASES) {
      if (usable(a[key])) { a.target = a[key].trim(); break; }
    }
  }
  // "element" is often the description from the snapshot — still a real target
  if (!usable(a.target) && usable(a.element)) a.target = a.element.trim();
  if (!usable(a.text) && usable(a.value)) a.text = a.value;
  if (!usable(a.text) && usable(a.content)) a.text = a.content;
  if (a.files === undefined && usable(a.file)) a.files = [a.file.trim()];
  if (a.files === undefined && usable(a.filename)) a.files = [a.filename.trim()];
  return a;
}

function parseAction(text) {
  const act = parseActionRaw(text);
  return act ? normalizeAction(act) : act;
}

function parseActionRaw(text) {
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
  // last resort: loose "action <name> ..." prose (web-fetch drift fallback)
  return parseLooseAction(text);
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
  act = normalizeAction(act);
  if (act.action === "navigate") return panelNavigate(act);
  if (act.action === "screenshot") return panelScreenshot();
  if (!state.attached) {
    const at = await attachPage(true);
    if (!at.ok)
      return "[TOOL RESULT] error: no attachable page — " + at.reason +
        '. Open a normal website first with {"action":"navigate","url":"https://…"}.';
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
  // A content script that never answers (page crashed, tab discarded, a modal
  // dialog) used to freeze the panel with no way out. Bound every page call.
  let res;
  try {
    res = await withTimeout(callAgent(tabId, cmd), 8000,
      "The page did not confirm the action within 8 seconds. Check the tab before retrying.");
  } catch (e) {
    return "[TOOL RESULT] error: " + (e && e.message ? e.message : e);
  }
  if (res.error) {
    // ids go stale as soon as the page re-renders (even our own clicks swap
    // DOM nodes). On "not found" fetch a fresh snapshot INLINE so the model's
    // NEXT step uses valid ids instead of guessing at dead ones.
    if (/not found/i.test(res.error) && ["click", "type", "press"].includes(act.action)) {
      const snap = await callAgent(tabId, { action: "read" });
      if (!snap.error) {
        state.attached.snapshot = snap;
        const elems = (snap.elements || [])
          .slice(0, 30)
          .map((e) => `- [${e.id}] ${e.desc}`)
          .join("\n");
        return (
          "[TOOL RESULT] error: " + res.error +
          "\nACTION DID NOT RUN. Fresh ids from a new snapshot of the page:\n" +
          (elems || "(no interactive elements visible right now)")
        );
      }
    }
    return "[TOOL RESULT] error: " + res.error;
  }

  switch (act.action) {
    case "click":
    case "press": {
      // A dispatched click proves nothing, and the model's next step would be a separate "read"
      // request. Read here instead: one request less per action, and fresh element ids.
      const after = await compactReadAfterAction(tabId);
      return "[TOOL RESULT] " + (act.action === "click" ? "Click" : "Key press") +
        " dispatched; the outcome is not verified" +
        (after ? ". The page right after it:\n" + after : ". Read the page before claiming success.");
    }
    case "scroll":
      return `[TOOL RESULT] scroll ok. Page title: ${res.title || state.attached.title}` +
        (res.notice ? ` (${res.notice})` : "");
    case "type":
      // verified result: the text is REALLY in the field now (read back)
      return `[TOOL RESULT] type confirmed — the field now holds ${res.typed} chars: "${res.preview || ""}"` +
        `. Page title: ${res.title || state.attached.title}`;
    case "extract":
      return "[TOOL RESULT]\n" + String(res.text || "").slice(0, 3000);
    case "read":
      state.attached.snapshot = res;
      return "[TOOL RESULT]\n" + snapshotToContext(res);
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

async function compactReadAfterAction(tabId) {
  await sleep(700);
  try {
    const snap = await withTimeout(callAgent(tabId, { action: "read" }), 6000, "read timed out");
    if (snap && !snap.error) {
      state.attached.snapshot = snap;
      return snapshotToContext(snap, 1500, 40);
    }
  } catch {}
  return "";
}

async function panelScreenshot() {
  try {
    const dataUrl = await captureScreenshot();
    const name = "screenshot-" + Date.now() + ".png";
    const file = dataUrlToFile(dataUrl, name);
    state.fileBridge.push({ path: name, size: file.size, text: "", file });
    updateAttachBadge();
    addScreenshotEl(dataUrl, name);
    return (
      "[TOOL RESULT] screenshot captured from the active tab (" +
      Math.max(1, Math.round(file.size / 1024)) + " KB), shown in the chat and " +
      'attached to the 📎 bridge as "' + name + '". To put it in a post, use ' +
      '{"action":"upload","files":["' + name + '"]} on that page (target the image/file input if needed).'
    );
  } catch (e) {
    return "[TOOL RESULT] error: " + screenshotError(e);
  }
}

/* ═══════════════════════════ chat rendering ═══════════════════════════ */

// Show a captured screenshot inline in the chat (proof to the user that a
// real image was taken) with a caption and a click-to-download link.
function addScreenshotEl(dataUrl, name) {
  const wrap = document.createElement("div");
  wrap.className = "msg msg-shot";
  const cap = document.createElement("div");
  cap.className = "shot-cap";
  cap.textContent = "📷 Screenshot — " + name;
  const img = document.createElement("img");
  img.className = "shot-img";
  img.src = dataUrl;
  img.alt = name;
  const dl = document.createElement("a");
  dl.className = "shot-dl";
  dl.href = dataUrl;
  dl.download = name;
  dl.textContent = "Download PNG";
  wrap.appendChild(cap);
  wrap.appendChild(img);
  wrap.appendChild(dl);
  $("chatLog").appendChild(wrap);
  $("chatLog").scrollTop = $("chatLog").scrollHeight;
}

// Re-rendering the whole reply (escape + 5 regexes + innerHTML) for every streamed token
// was the main source of panel lag on long answers. Coalesce into one render per 80 ms and
// only follow the stream if the user has not scrolled up.
function scheduleRender(bubble) {
  if (bubble._renderTimer) return;
  bubble._renderTimer = setTimeout(() => {
    bubble._renderTimer = null;
    const log = $("chatLog");
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    bubble.innerHTML = mdLite(stripGlmBlocks(bubble._raw || "") || "…");
    if (stick) log.scrollTop = log.scrollHeight;
  }, 80);
}

function addMsgEl(kind, text) {
  const div = document.createElement("div");
  div.className = "msg msg-" + kind;
  if (kind === "tool") {
    const t = String(text);
    const isStatus = /^(🔐|🛡|📎|🔁|↩|\[stopped|\[unparseable)/.test(t);
    if (!isStatus) {
      // raw [TOOL RESULT] / step output — collapsed one-liner, click to expand
      const d = document.createElement("details");
      d.className = "tool-fold";
      const summary = document.createElement("summary");
      const head = t.split("\n")[0].replace(/\s+/g, " ").trim();
      summary.textContent = head.length > 90 ? head.slice(0, 90) + " …" : head;
      const body = document.createElement("div");
      body.className = "tool-body";
      body.textContent = t;
      d.appendChild(summary);
      d.appendChild(body);
      div.appendChild(d);
    } else {
      div.innerHTML = esc(t); // short status announcements stay visible
    }
  } else {
    div.innerHTML = kind === "user" || kind === "assistant" ? mdLite(text) : esc(text);
  }
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

// New chat: wipe the conversation but keep the connection, attachment settings
// and the saved API key untouched. (Was wired to the ＋ button without ever
// being defined — the missing definition crashed the whole panel init and
// silently disabled the send button / Enter key. Fixed in 1.0.36.)
function newChat() {
  state.messages = [];
  state.chatTitle = "New chat";
  state.chatId = uuid();
  state.attached = null;
  state.pageNote = null;
  $("pageChip").classList.add("hidden");
  renderHistory();
  updateAttachBadge();
  toast("New chat started.");
}

/* ═══════════════════════════ send / agent loop ═══════════════════════════ */

async function send() {
  if (state.busy) return;
  const input = $("input");
  const text = input.value.trim();
  if (!text) return;
  if (!state.token) {
    toast("Click Connect first (you will be guided to create a free Z.ai API key).");
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
    let executedThisTurn = 0;
    let refusals = 0; // times the model refused to act or claimed an action it never ran
    let lastAction = ""; // last action that actually succeeded, to catch stalls
    let lastReply = "";
    while (steps < MAX_AGENT_STEPS) {
      steps++;
      const messages = buildLlmMessages();
      bubble = addMsgEl("assistant", "");
      bubble.classList.add("cursor-blink");
      let thinkEl = null;

      const { content, reasoning } = await streamCompletion({
        messages,
        signal: state.abort.signal,
        onDelta: (rDelta, cDelta) => {
          if (rDelta) {
            if (!thinkEl) {
              thinkEl = document.createElement("details");
              thinkEl.className = "msg msg-thinking";
              thinkEl.innerHTML = `<summary>💭 thinking</summary><div class="think-body"></div>`;
              thinkEl._text = document.createTextNode("");
              thinkEl.querySelector(".think-body").appendChild(thinkEl._text);
              $("chatLog").insertBefore(thinkEl, bubble);
            }
            thinkEl._text.appendData(rDelta); // no whole-string rewrite per token
          }
          if (cDelta) {
            bubble._raw = (bubble._raw || "") + cDelta;
            scheduleRender(bubble); // re-render at most ~12x/s, not once per token
          }
        }
      });

      bubble.classList.remove("cursor-blink");
      if (bubble._renderTimer) { clearTimeout(bubble._renderTimer); bubble._renderTimer = null; }
      const rawContent = String(content || bubble._raw || "");
      const visibleContent = stripGlmBlocks(rawContent);
      bubble._raw = visibleContent || "(empty reply)";
      bubble.innerHTML = mdLite(bubble._raw);
      if (reasoning && !thinkEl) {
        thinkEl = document.createElement("details");
        thinkEl.className = "msg msg-thinking";
        thinkEl.innerHTML = `<summary>💭 thinking</summary><div class="think-body">${esc(reasoning)}</div>`;
        $("chatLog").insertBefore(thinkEl, bubble);
      }

      // Native <glm_block> calls never really run on Z.ai's side. Parse them
      // here and execute them for real instead of letting the model pretend
      // it succeeded on an empty tool result.
      let nativeAct = null;
      let act = parseAction(rawContent);
      if (!act) {
        nativeAct = parseNativeMcpAction(rawContent);
        act = nativeAct;
      }
      if (nativeAct) {
        bubble._raw = "⚙ " + nativeAct.action + " — running in the page…";
        bubble.innerHTML = mdLite(bubble._raw);
      }
      // Keep the model's own history coherent: it "said" an action block,
      // then receives the [TOOL RESULT] of the action we really executed.
      const storedContent = nativeAct
        ? "```action\n" + JSON.stringify(nativeAct) + "\n```"
        : visibleContent;
      state.messages.push({ role: "assistant", content: storedContent });
      lastReply = visibleContent;
      if (!act) {
        // A long reply is an answer, not a refusal: the guards only apply to short replies.
        const shortReply = visibleContent.length < 800;
        const denied = shortReply && CAPABILITY_DENIAL_RE.test(visibleContent);
        const claimed = shortReply && ACTION_CLAIM_RE.test(visibleContent);
        // The model either refused ("I have no click/type tool") or described an
        // action it never ran. Neither is an acceptable answer while the task is
        // still undone — never let a refusal end the turn as if it were a result.
        if (executedThisTurn === 0 && (denied || claimed) && refusals < 2) {
          refusals++;
          bubble.remove(); // do not leave a false claim standing in the chat
          if (refusals === 1) {
            addMsgEl("tool", denied
              ? "↩ The model claimed it has no browser tools — correcting it (1/2)…"
              : "↩ The model described an action it never ran — correcting it (1/2)…");
            state.messages.push({
              role: "user",
              content:
                "[SYSTEM] Stop — that reply is not acceptable. Your statement about your own tools is factually wrong for this session. " +
                "You are NOT the chat.z.ai assistant here: you are the agent running inside a Chrome extension, and the fenced ```action blocks in your instructions " +
                "(click / type / press / scroll / extract / read / navigate / screenshot / upload) are executed FOR REAL in the user's active tab. " +
                "The [PAGE SNAPSHOT] you received is the live DOM of that tab, not a web fetch, and it is not empty. " +
                "Do not describe your capabilities, do not say you cannot control the browser, do not tell the user to do it themselves. " +
                "Emit exactly ONE ```action block now for the next step of the user's request — or name one concrete blocker that is visible in the page data."
            });
            continue;
          }
          addMsgEl("tool", "↩ Still no action block — asking for one literal line (2/2)…");
          state.messages.push({
            role: "user",
            content:
              "[SYSTEM] Copy the block below verbatim, with no other text before or after it:\n" +
              '```action\n{"action":"read"}\n```'
          });
          continue;
        }
        if (executedThisTurn === 0 && (denied || claimed)) {
          bubble.remove();
          addMsgEl("error",
            "Stopped: the model refused to act twice, so nothing was executed. No page was clicked, no text was typed and nothing was published. " +
            "Re-send the request, or switch the model in Settings and try again.");
          break;
        }
        break; // a plain answer with no pending work — done
      }
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

      // A repeated identical action is the model stalling: typing the same draft
      // twice, clicking the same button twice. Do not run it again — say so.
      const signature = JSON.stringify(act);
      if (signature === lastAction && ["click", "type", "press", "upload"].includes(act.action)) {
        const repeat = "[TOOL RESULT] That exact action already ran and succeeded. Do not repeat it. " +
          "Take the NEXT step (type the post text, click the Post button, or read the page to confirm), " +
          "or answer with {\"action\":\"done\"} if the task is finished.";
        addMsgEl("tool", "↩ Same action repeated — skipped; asking for the next step.");
        state.messages.push({ role: "user", content: repeat });
        continue;
      }
      const result = await executeAction(act);
      if (!/^\[TOOL RESULT\] error:/.test(result)) { executedThisTurn++; lastAction = signature; }
      else lastAction = "";
      addMsgEl("tool", result.length > 400 ? result.slice(0, 400) + " …" : result);
      state.messages.push({ role: "user", content: result });
    }
    if (steps >= MAX_AGENT_STEPS) {
      addMsgEl("assistant", "_Reached the step limit (" + MAX_AGENT_STEPS + " actions). Ask me to continue if needed._");
    }
  } catch (e) {
    if (bubble && !bubble._raw) bubble.remove(); // drop the empty placeholder
    if (String(e.message || e).includes("abort")) {
      addMsgEl("tool", "[stopped by user]");
    } else {
      addMsgEl("error", "⚠ " + (e.message || e));
    }
  } finally {
    clearStatus();
    state.busy = false;
    $("btnSend").disabled = false;
    $("btnStop").classList.add("hidden");
    state.abort = null;
  }
}


// Every step re-sends the history. Keep the two newest page snapshots verbatim, stub out
// older ones, and stop once the history passes a budget (newest turns win).
const HISTORY_BUDGET = 14000;

function compactHistory(list) {
  let snapshotsKept = 0;
  const stubbed = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    let content = String(m.content || "");
    if (m.role === "user" && content.includes("[PAGE SNAPSHOT]")) {
      snapshotsKept++;
      if (snapshotsKept > 2)
        content = content.split("\n")[0] + "\n[earlier page snapshot omitted to keep this request small]";
    }
    stubbed.unshift({ ...m, content });
  }
  let total = 0;
  const kept = [];
  for (let i = stubbed.length - 1; i >= 0; i--) {
    const len = stubbed[i].content.length;
    if (total + len > HISTORY_BUDGET && kept.length >= 4) break;
    total += len;
    kept.unshift(stubbed[i]);
  }
  return kept;
}

function buildLlmMessages() {
  const msgs = [{ role: "system", content: SYSTEM_PROMPT }];
  const hist = compactHistory(state.messages.slice(-30));
  const last = hist[hist.length - 1];
  const lastIsTool = !!last && last.role === "user" && /^\[TOOL RESULT\]/.test(String(last.content));
  // Mid-task the tool results already carry the page; sending the stored snapshot again every
  // step doubles the request. Send it on a new user turn, or when no recent message has one.
  const snapRecent = hist.slice(-8).some((m) => m.role === "user" && String(m.content).includes("[PAGE SNAPSHOT]"));
  if (state.attached && state.attached.snapshot) {
    if (!(lastIsTool && snapRecent))
      msgs.push({ role: "user", content: snapshotToContext(state.attached.snapshot) });
  } else if (state.pageNote) {
    msgs.push({
      role: "user",
      content:
        "[PAGE SNAPSHOT UNAVAILABLE] " + state.pageNote +
        " — the extension could not read the active tab. If the user asks about the page, say " +
        "exactly that and suggest opening a normal website tab or reloading it (F5)."
    });
  }
  if (state.fileBridge && state.fileBridge.length) {
    msgs.push({ role: "user", content: fileBridgeContext(false) });
  }
  if (last && last.role === "user" && !lastIsTool && !/^\[PAGE SNAPSHOT/.test(last.content)) {
    hist[hist.length - 1] = {
      ...last,
      content: last.content + "\n\n(To act on the page, reply with exactly one ```action block; the extension runs it in the active tab.)"
    };
  }
  msgs.push(...hist);
  return msgs;
}

/* ═══════════════════════════ settings ═══════════════════════════ */

function saveSettings() {
  localStorage.setItem(
    "zaiPanelSettings",
    JSON.stringify({
      model: state.model,
      confirmMode: state.confirmMode,
      autoAttach: state.autoAttach,
      showStatus: state.showStatus
    })
  );
}

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("zaiPanelSettings") || "{}");
    if (s.model) state.model = s.model;
    if (typeof s.confirmMode === "boolean") state.confirmMode = s.confirmMode;
    if (typeof s.autoAttach === "boolean") state.autoAttach = s.autoAttach;
    if (typeof s.showStatus === "boolean") state.showStatus = s.showStatus;
  } catch {}
  $("confirmMode").checked = state.confirmMode;
  $("autoAttach").checked = state.autoAttach;
  $("showStatus").checked = state.showStatus;
  $("modelCustom").value = "";
}

/* ═══════════════════════════ wiring ═══════════════════════════ */

document.addEventListener("DOMContentLoaded", async () => {
  loadSettings();

  $("btnConnect").onclick = connect;
  $("btnSettings").onclick = () => $("settingsPanel").classList.toggle("hidden");
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
  $("modelSelect").onchange = () => { localStorage.setItem("zaiApiModelChosen", "1"); syncModelFromUi(); };
  $("modelCustom").oninput = () => { localStorage.setItem("zaiApiModelChosen", "1"); syncModelFromUi(); };
  $("confirmMode").onchange = (e) => {
    state.confirmMode = e.target.checked;
    saveSettings();
  };
  $("autoAttach").onchange = (e) => {
    state.autoAttach = e.target.checked;
    saveSettings();
  };
  $("showStatus").onchange = (e) => {
    state.showStatus = e.target.checked;
    saveSettings();
  };
  $("btnSaveApiKey").onclick = async () => {
    const k = $("apiKey").value.trim();
    $("apiKey").value = "";
    if (k) {
      localStorage.setItem("zaiApiKey", k);
      await connect();
    } else {
      localStorage.removeItem("zaiApiKey");
      state.apiKey = "";
      state.token = "";
      setConn("Not connected", "conn-off");
      toast("API key removed.");
    }
  };
  // privacy / data controls (matches the published privacy policy)
  $("btnDisconnect").onclick = () => {
    localStorage.removeItem("zaiApiKey");
    state.apiKey = "";
    state.token = "";
    state.userName = "";
    state.chatId = uuid();
    state.chatTitle = "New chat";
    state.messages = [];
    state.attached = null;
    state.fileBridge = [];
    $("pageChip").classList.add("hidden");
    renderHistory();
    updateAttachBadge();
    setConn("Not connected", "conn-off");
    toast("Disconnected — the saved API key was removed from this browser.");
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
  const savedApiKey = (localStorage.getItem("zaiApiKey") || "").trim();
  state.apiKey = savedApiKey;
  await refreshModels();
  const saved = JSON.parse(localStorage.getItem("zaiPanelSettings") || "{}");
  if (saved.model && [...$("modelSelect").options].some((o) => o.value === saved.model)) {
    $("modelSelect").value = saved.model;
  } else if (saved.model) {
    $("modelCustom").value = saved.model;
  }
  syncModelFromUi();

  // auto-reconnect when a key is saved
  if (savedApiKey) connect();
});
