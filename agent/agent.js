// Z.ai Sidepanel Agent — content-side agent (injected on demand)
// Provides a snapshot of the active page plus click/type/scroll/extract.
// Interactive elements are tagged with stable data-zai-id attributes so the
// model can reference them as "e12" style targets.

"use strict";

(function () {
  if (window.__zaiAgent) return;

  const MAX_TEXT = 5000;
  const MAX_ELEMENTS = 60;

  let idCounter = 0;

  function isVisible(el) {
    if (!el || !el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || +style.opacity === 0) {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const text = (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") ||
      el.getAttribute("name") || el.getAttribute("title") || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 80);
    const type = el.getAttribute("type");
    let role = tag;
    if (tag === "a") role = "link";
    else if (tag === "button") role = "button";
    else if (tag === "input" || tag === "textarea") role = "input" + (type ? ":" + type : "");
    else if (tag === "select") role = "select";
    else role = el.getAttribute("role") || tag;
    return `${role}${text ? ` "${text}"` : ""}`;
  }

  function collectInteractive() {
    const selector = [
      "a[href]", "button", "input", "textarea", "select",
      "[role=button]", "[role=link]", "[role=tab]", "[role=checkbox]",
      "[onclick]", "[contenteditable=true]"
    ].join(",");
    const all = Array.from(document.querySelectorAll(selector));
    const out = [];
    idCounter = 0;
    // clear old marks
    document.querySelectorAll("[data-zai-id]").forEach((el) => el.removeAttribute("data-zai-id"));
    for (const el of all) {
      if (out.length >= MAX_ELEMENTS) break;
      if (!isVisible(el)) continue;
      // skip our own panel if present on page
      if (el.closest("[data-zai-extension-root]")) continue;
      const id = "e" + ++idCounter;
      el.setAttribute("data-zai-id", id);
      out.push({ id, desc: describe(el) });
    }
    return out;
  }

  function mainText() {
    const pick = document.querySelector("main, article, [role=main]") || document.body;
    let t = (pick.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    if (t.length < 40 && pick !== document.body) {
      // <main> exists but is nearly empty — fall back to the whole body
      t = (document.body.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    }
    if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT) + " …[truncated]";
    return t;
  }

  function snapshot() {
    let selection = "";
    try { selection = String(window.getSelection() || ""); } catch {}
    return {
      title: document.title,
      url: location.href,
      text: mainText(),
      selection: selection.slice(0, 1500),
      elements: collectInteractive()
    };
  }

  // Models rarely send "e12" exactly. They send ref/id, the element's id
  // attribute, or a human label such as "Start a post button". All of these
  // must land on the same element, or the agent burns its whole step budget on
  // "element not found".
  const GENERIC_WORDS = new Set(["button", "btn", "link", "field", "input", "box", "icon",
    "element", "item", "tab", "area", "section", "the", "a", "an"]);

  const tokenize = (value) => String(value || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

  function normLabel(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/["'“”‘’]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function accessibleName(el) {
    return normLabel([
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      el.getAttribute("title"),
      el.getAttribute("name"),
      el.getAttribute("alt"),
      el.getAttribute("value"),
      el.id,
      el.innerText || el.textContent || ""
    ].filter((v) => typeof v === "string" && v.trim()).join(" | "));
  }

  function findByLabel(raw) {
    const wanted = normLabel(raw);
    const wantedTokens = tokenize(wanted).filter((t) => !GENERIC_WORDS.has(t));
    if (!wantedTokens.length) return null;
    const wantedCore = wantedTokens.join(" ");
    const pool = Array.from(document.querySelectorAll(
      "a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[contenteditable=true]"
    )).filter(isVisible);
    const scored = [];
    for (const el of pool) {
      const name = accessibleName(el);
      if (!name) continue;
      const nameTokens = tokenize(name);
      const set = new Set(nameTokens);
      let score = 0;
      if (name === wanted) score = 100;
      else if (name === wantedCore) score = 90;
      else if (name.startsWith(wanted) || name.startsWith(wantedCore)) score = 80;
      else if (wantedTokens.length >= 2 && wantedTokens.every((t) => set.has(t))) score = 60;
      else if (wantedTokens.length === 1 && nameTokens.length <= 2 && set.has(wantedTokens[0])) score = 50;
      if (score) scored.push({ el, score });
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score);
    const best = scored.filter((s) => s.score === scored[0].score);
    if (best.length === 1) return best[0].el;
    const listed = best.slice(0, 4).map((s) => {
      const id = s.el.getAttribute("data-zai-id");
      return describe(s.el) + (id ? " [" + id + "]" : "");
    });
    throw new Error(
      'target "' + raw + '" matches ' + best.length + " elements: " + listed.join("; ") +
      ". Send the id of the one you mean."
    );
  }

  function findTarget(id) {
    // snapshot ids are "e12"-style; models also send a CSS selector, a label,
    // or the description from the snapshot — accept all of them
    const raw = String(id == null ? "" : id).trim();
    if (raw) {
      const el = document.querySelector(`[data-zai-id="${CSS.escape(raw)}"]`);
      if (el) return el;
      if (!/^[a-z]?\d+$/i.test(raw)) {
        // not id-shaped → try it as a CSS selector
        try {
          const sel = document.querySelector(raw);
          if (sel) return sel;
        } catch {}
        const byLabel = findByLabel(raw);
        if (byLabel) return byLabel;
      }
    }
    throw new Error(
      "element \"" + (raw || "undefined") + "\" not found — send a target from the " +
      "snapshot (e.g. e12), a CSS selector like a[href*='name'], or the visible " +
      'label like "Start a post"; send action "read" first for a fresh snapshot'
    );
  }

  function fireInput(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // read back what the field REALLY holds — the ground truth for the
  // type/press verification the model reports to the user
  function readVal(el) {
    if (!el) return "";
    if (!el.isContentEditable) return String(el.value ?? "");
    // Chrome represents Enter as a block and an empty line as <div><br>.
    // innerText can count that empty line twice; read the editor structure
    // without collapsing text, trimming lines, or overlooking truncation.
    const isBlock = (node) => node.nodeType === Node.ELEMENT_NODE && /^(DIV|P|LI|PRE|BLOCKQUOTE)$/.test(node.tagName);
    const read = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      if (node.tagName === "BR") return "\n";
      const children = [...node.childNodes];
      if (children.length === 1 && children[0].nodeName === "BR") return "";
      let out = "", blockBefore = false, hasPart = false;
      for (const child of children) {
        if (child.nodeType !== Node.TEXT_NODE && child.nodeType !== Node.ELEMENT_NODE) continue;
        const isLine = isBlock(child);
        if (hasPart && (isLine || blockBefore)) out += "\n";
        out += read(child);
        hasPart = true;
        blockBefore = isLine;
      }
      return out;
    };
    return read(el);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  const handlers = {
    read() {
      return snapshot();
    },
    click(cmd) {
      const el = findTarget(cmd.target || cmd.selector || cmd.element);
      if (!isVisible(el) || el.matches(':disabled, [aria-disabled="true"]')) throw new Error("The click target is hidden or disabled.");
      el.scrollIntoView({ block: "center" });
      el.click();
      return { ok: true, title: document.title };
    },
    async type(cmd) {
      if (typeof cmd.text !== "string" || !cmd.text.trim()) throw new Error("type requires the complete text");
      const el = findTarget(cmd.target || cmd.selector || cmd.element);
      const editable = el.isContentEditable && !el.parentElement?.isContentEditable;
      const plain = el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLInputElement && ["text", "search", "url", "tel", "email"].includes(el.type));
      if ((!editable && !plain) || el.disabled || el.readOnly || !isVisible(el)) throw new Error("Choose a visible, writable text field or editor.");
      const expected = cmd.text.replace(/\r\n?/g, "\n");
      if (el instanceof HTMLInputElement && expected.includes("\n")) throw new Error("This is a single-line input; choose the multiline editor.");
      el.scrollIntoView({ block: "center" });
      el.focus();
      if (editable) {
        // Select only this editor. Editing through Chrome fires input events
        // used by editor frameworks and preserves paragraph breaks.
        if (document.activeElement !== el) throw new Error("Chrome could not focus the selected editor.");
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        if (!document.execCommand("insertText", false, expected)) throw new Error("This editor did not accept the text; paste the draft manually.");
      } else {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, expected);
        fireInput(el);
      }
      await sleep(150);
      const now = readVal(el).replace(/\r\n?/g, "\n");
      if (!el.isConnected || now !== expected) {
        throw new Error("The editor did not keep the complete text. Do not submit; review the draft in the page.");
      }
      return { ok: true, title: document.title, typed: now.length, preview: now.slice(0, 60) };
    },
    async press(cmd) {
      const k = String(cmd.key || "Enter");
      const el = findTarget(cmd.target || cmd.selector || cmd.element);
      el.focus();
      const init = { key: k, bubbles: true, cancelable: true };
      if (k === "Enter") { init.code = "Enter"; init.keyCode = 13; init.which = 13; }
      const proceed = el.dispatchEvent(new KeyboardEvent("keydown", init));
      if (proceed) el.dispatchEvent(new KeyboardEvent("keypress", init));
      el.dispatchEvent(new KeyboardEvent("keyup", init));
      return { ok: true, title: document.title, notice: "Submission not verified. Read the page or use the explicit submit button." };
    },
    scroll({ direction }) {
      const map = {
        down: () => window.scrollBy({ top: Math.round(window.innerHeight * 0.8), behavior: "smooth" }),
        up: () => window.scrollBy({ top: -Math.round(window.innerHeight * 0.8), behavior: "smooth" }),
        top: () => window.scrollTo({ top: 0, behavior: "smooth" }),
        bottom: () => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })
      };
      (map[direction] || map.down)();
      return { ok: true, title: document.title };
    },
    extract(cmd) {
      // models oscillate between "query" and "selector" — accept both
      const query = cmd.query || cmd.selector || cmd.css;
      if (!query) throw new Error(
        'extract needs a CSS selector in "query" (e.g. "button[aria-label]"); a "prompt" is not a selector — ' +
        'use {"action":"read"} to get the page content and its element ids'
      );
      const els = Array.from(document.querySelectorAll(query));
      if (!els.length) throw new Error("no element matches: " + query);
      // join ALL matches — "extract all repositories" means every one, not
      // just the first link on the page
      const text = els
        .map((e) => (e.innerText || "").trim())
        .filter(Boolean)
        .join("\n")
        .slice(0, 3000);
      return { text, count: els.length };
    },
    navigate(cmd) {
      // Kept for the side panel's in-tab navigation path: the panel verifies
      // the destination URL and this only assigns location.href.
      const raw = String(cmd.url || cmd.link || cmd.href || "").trim();
      if (!raw) throw new Error("navigate requires a URL");
      let url;
      try {
        url = new URL(raw, location.href).href;
      } catch {
        throw new Error("navigate requires a valid URL (got: " + raw + ")");
      }
      if (!/^https?:/i.test(url)) throw new Error("navigate only supports http(s) URLs (got: " + url + ")");
      location.href = url;
      return { ok: true, url };
    },
    upload(cmd) {
      // The side panel resolves the model's file names against the 📎 file
      // bridge and ships real payloads here; we rebuild genuine File objects
      // and hand them to the page's own file input.
      const payloads = Array.isArray(cmd.files) ? cmd.files : [];
      if (!payloads.length)
        throw new Error(
          'upload received no file payloads — "files" is resolved from the files the user attached with 📎; ask them to attach the folder first'
        );
      const sel = String(cmd.target || cmd.selector || "").trim();
      let input = null;
      if (sel) {
        try { input = document.querySelector(sel); } catch {}
      }
      if (!sel) {
        const inputs = document.querySelectorAll('input[type="file"]');
        if (inputs.length !== 1) throw new Error("Choose one explicit file input.");
        input = inputs[0];
      }
      if (!(input instanceof HTMLInputElement) || input.type !== "file" || input.disabled)
        throw new Error(
          "no file input on this page — open the site's upload page first " +
          "(e.g. github.com/<owner>/<repo>/upload/main), then retry"
        );
      const dt = new DataTransfer();
      const names = [];
      for (const f of payloads) {
        const bin = atob(String(f.b64 || ""));
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        // an upload page files items into its CURRENT directory — the model
        // groups by folder and commits one directory at a time
        const name = String(f.path || f.name || "file.txt").split("/").pop() || "file.txt";
        dt.items.add(new File([u8], name, { type: f.type || "application/octet-stream" }));
        names.push(name);
      }
      if (dt.files.length > 1 && !input.multiple) throw new Error("This file input accepts only one file.");
      input.files = dt.files;
      fireInput(input);
      return { ok: true, count: names.length, names, title: document.title };
    }
  };

  window.__zaiAgent = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "ZAI_AGENT_CMD") return;
    const cmd = msg.cmd || {};
    const fn = Object.hasOwn(handlers, cmd.action) ? handlers[cmd.action] : null;
    try {
      if (!fn) throw new Error("unknown action: " + cmd.action);
      if (cmd.pageUrl && cmd.pageUrl !== location.href) throw new Error("The selected document changed; read the page again.");
      const out = fn(cmd);
      // type/press are async (they verify by reading the value back)
      if (out && typeof out.then === "function") {
        out.then(sendResponse).catch((e) =>
          sendResponse({ error: String(e && e.message ? e.message : e) })
        );
      } else {
        sendResponse(out);
      }
    } catch (e) {
      sendResponse({ error: String(e && e.message ? e.message : e) });
    }
    return true;
  });
})();
