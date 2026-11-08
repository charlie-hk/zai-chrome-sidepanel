// Z.ai Sidepanel Agent — content-side agent (injected on demand)
// Provides a snapshot of the active page plus click/type/scroll/extract.
// Interactive elements are tagged with stable data-zai-id attributes so the
// model can reference them as "e12" style targets.

"use strict";

(function () {
  if (window.__zaiAgent) return;

  const MAX_TEXT = 7000;
  const MAX_ELEMENTS = 80;

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

  function findTarget(id) {
    // snapshot ids are "e12"-style; models also often send a CSS selector
    // directly ("a[href*='foo']") — accept both
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
      }
    }
    throw new Error(
      "element \"" + (raw || "undefined") + "\" not found — send a target from the " +
      "snapshot (e.g. e12) or a CSS selector like a[href*='name']; " +
      "send action \"read\" first for a fresh snapshot"
    );
  }

  function fireInput(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const handlers = {
    read() {
      return snapshot();
    },
    click(cmd) {
      const el = findTarget(cmd.target || cmd.selector || cmd.element);
      el.scrollIntoView({ block: "center" });
      el.click();
      return { ok: true, title: document.title };
    },
    type(cmd) {
      if (typeof cmd.text !== "string") throw new Error("type requires text");
      const el = findTarget(cmd.target || cmd.selector || cmd.element);
      el.scrollIntoView({ block: "center" });
      el.focus();
      if (el.isContentEditable) {
        el.textContent = cmd.text;
        fireInput(el);
      } else {
        // React-friendly: use the native setter so frameworks notice
        const proto =
          el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
        setter.call(el, text);
        fireInput(el);
      }
      return { ok: true, title: document.title };
    },
    press(cmd) {
      const k = String(cmd.key || "Enter");
      let el = null;
      try {
        const t = cmd.target || cmd.selector || cmd.element;
        el = t ? findTarget(t) : document.activeElement || document.body;
      } catch {
        el = document.activeElement || document.body;
      }
      if (el && el.focus) el.focus();
      const init = { key: k, bubbles: true, cancelable: true };
      if (k === "Enter") { init.code = "Enter"; init.keyCode = 13; init.which = 13; }
      el.dispatchEvent(new KeyboardEvent("keydown", init));
      el.dispatchEvent(new KeyboardEvent("keypress", init));
      el.dispatchEvent(new KeyboardEvent("keyup", init));
      // some sites only react to a real form submit — fall back once, but
      // only if the synthetic key didn't navigate already
      if (k === "Enter") {
        let form = null;
        try { form = el.closest ? el.closest("form") : null; } catch {}
        if (form) {
          const before = location.href;
          setTimeout(() => {
            try {
              if (location.href === before && form.requestSubmit) form.requestSubmit();
            } catch {}
          }, 250);
        }
      }
      return { ok: true, title: document.title };
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
      if (!query) throw new Error('extract requires a CSS query (key "query" — "selector" is accepted too)');
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
      const raw = String(cmd.url || cmd.link || cmd.href || "").trim();
      if (!raw) throw new Error("navigate requires a URL");
      let url;
      try {
        url = new URL(raw, location.href).href; // relative paths resolve against the current page
      } catch {
        throw new Error("navigate requires a valid URL (got: " + raw + ")");
      }
      if (!/^https?:/i.test(url)) {
        throw new Error("navigate only supports http(s) URLs (got: " + url + ")");
      }
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
      if (!input) input = document.querySelector('input[type="file"]');
      if (!input)
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
      input.files = dt.files;
      fireInput(input);
      return { ok: true, count: names.length, names, title: document.title };
    }
  };

  window.__zaiAgent = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "ZAI_AGENT_CMD") return;
    const cmd = msg.cmd || {};
    const fn = handlers[cmd.action];
    try {
      if (!fn) throw new Error("unknown action: " + cmd.action);
      sendResponse(fn(cmd));
    } catch (e) {
      sendResponse({ error: String(e && e.message ? e.message : e) });
    }
    return true;
  });
})();
