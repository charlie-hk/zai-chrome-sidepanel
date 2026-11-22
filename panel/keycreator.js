// Runs INSIDE the user's own Z.ai API-keys page, only after the user approved it in the panel.
// It uses the page's visible controls (the same ones the user would click): press the "create key"
// button, name the key, confirm, then read the key the page shows. It uses no private endpoints,
// does not touch captchas (if one appears the user solves it) and returns only the new key.
// Injected with chrome.scripting.executeScript({func}), so it must stay self-contained.
function zaiKeyCreator(keyName) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const KEY_RES = [/\b[0-9a-f]{32}\.[A-Za-z0-9]{8,32}\b/g, /\b[A-Za-z0-9]{24,}\.[A-Za-z0-9]{8,}\b/g];

  const shown = (el) => {
    if (!el || el.hidden || el.getAttribute("aria-hidden") === "true") return false;
    const st = getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden";
  };
  // visible text only: never the source of <script>/<style> elements
  const pageText = () => {
    if (document.body.innerText) return document.body.innerText;
    const out = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const tag = n.parentNode && n.parentNode.nodeName;
      if (tag !== "SCRIPT" && tag !== "STYLE" && tag !== "NOSCRIPT") out.push(n.nodeValue);
    }
    return out.join(" ");
  };
  const findKeys = () => {
    let hay = pageText();
    for (const f of document.querySelectorAll("input, textarea")) if (f.value) hay += "\n" + f.value;
    const out = [];
    for (const re of KEY_RES) for (const m of hay.matchAll(re)) out.push(m[0]);
    return [...new Set(out)];
  };
  const waitFor = async (fn, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(250);
    }
  };
  const BAD = /cancel|close|delete|remove|revoke|取消|关闭|删除/i;
  const findButton = (re, root) => {
    const cands = root.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]');
    let best = null;
    for (const el of cands) {
      if (!shown(el) || el.disabled) continue;
      const t = (el.getAttribute("aria-label") || el.textContent || el.value || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > 40 || BAD.test(t) || !re.test(t)) continue;
      if (!best || t.length < best.t.length) best = { el, t }; // the shortest label is the most specific
    }
    return best && best.el;
  };

  return (async () => {
    try {
      await waitFor(() => (document.body && pageText().trim().length > 30) || null, 10000);
      if (document.querySelector('input[type="password"]') ||
          /login|signin|sign-in|passport|\/auth/i.test(location.pathname))
        return { ok: false, stage: "not_logged_in" };

      const before = new Set(findKeys());
      const create = await waitFor(
        () => findButton(/create|new\s*(api\s*)?key|add\s*(api\s*)?key|generate|创建|新建|添加/i, document), 12000);
      if (!create) return { ok: false, stage: "no_create_button" };
      create.click();

      const dialog = await waitFor(() => {
        const d = document.querySelector('[role="dialog"], [aria-modal="true"], .ant-modal, .el-dialog, .modal, [class*="Modal"], [class*="dialog"]');
        return d && shown(d) ? d : null;
      }, 4000);
      if (dialog) {
        const input = dialog.querySelector('input:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea');
        if (input && !input.value) {
          const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, "value").set.call(input, keyName);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        const confirm = findButton(/confirm|^ok$|create|submit|save|generate|确定|确认|创建|提交|保存/i, dialog);
        if (confirm) confirm.click();
      }

      const key = await waitFor(() => findKeys().find((k) => !before.has(k)) || null, 15000);
      return key ? { ok: true, key } : { ok: false, stage: "key_not_found" };
    } catch (e) {
      return { ok: false, stage: "exception", error: String((e && e.message) || e) };
    }
  })();
}
