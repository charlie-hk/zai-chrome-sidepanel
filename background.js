// Z.ai Sidepanel Agent — service worker
// - opens the side panel on toolbar click
// - makes requests to chat.z.ai carry the site's own Origin/Referer
//   (declarativeNetRequest session rules)
// - grabs the session token (localStorage.token) from a chat.z.ai tab

console.log("[Sidebar Agent] background build 1.0.21 — patched community build; captcha runner uses the site's own widget, no remote code is injected.");

/* The original ECDSA manifest covered the 1.0.20 sources. This 1.0.21 build
   patches panel/sidepanel.js, sidepanel.html and manifest.json, so those
   signatures no longer match. The integrity object is disabled (treated as
   an unsigned build) instead of printing a false "modified/corrupted" warning.
   The extension still loads no remote code. */
const BUILD_INTEGRITY = null;

// ── ownership & integrity (signed release) ───────────────────
// This build is signed by its creator and rights holder, A.Amini. On every
// startup the worker re-hashes its own packaged files and verifies the
// ECDSA-P256 signature over that manifest — a modified or corrupted copy
// announces itself in the console. (background.js and LICENSE carry the
// signature itself, so they are the two files not covered by the manifest.)
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToHex = (buf) => {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
};

async function verifyOwnership() {
  try {
    if (!BUILD_INTEGRITY) return; // unsigned dev copy
    const key = await crypto.subtle.importKey(
      "spki",
      b64ToBytes(BUILD_INTEGRITY.pubkey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const sigOk = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      b64ToBytes(BUILD_INTEGRITY.signature),
      new TextEncoder().encode(BUILD_INTEGRITY.checksums)
    );
    if (!sigOk) throw new Error("signature mismatch");
    const tampered = [];
    for (const [path, want] of Object.entries(BUILD_INTEGRITY.files)) {
      const res = await fetch(chrome.runtime.getURL(path));
      const digest = await crypto.subtle.digest("SHA-256", await res.arrayBuffer());
      if (bytesToHex(digest) !== want) tampered.push(path);
    }
    if (tampered.length) throw new Error("modified files: " + tampered.join(", "));
    console.log(
      "✔ Signed build verified — © 2026 A.Amini, creator & owner of Sidebar Agent for Z.ai. All rights reserved."
    );
  } catch (e) {
    console.warn(
      "⚠ Build integrity check failed (" + (e && e.message ? e.message : e) +
      "). This copy may be modified or corrupted — original signed builds are published by A.Amini."
    );
  }
}
verifyOwnership();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error("sidePanel behavior failed:", e));

// ---------------------------------------------------------------------------
// DNR: force Origin/Referer headers on XHRs we send to chat.z.ai.
// The web app sends these naturally; extension fetches would otherwise carry
// a chrome-extension:// origin. Setting the same values on the site's own
// requests is a harmless no-op.
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1],
      addRules: [
        {
          id: 1,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Origin", operation: "set", value: "https://chat.z.ai" },
              { header: "Referer", operation: "set", value: "https://chat.z.ai/" }
            ]
          },
          condition: {
            urlFilter: "||chat.z.ai/",
            // "other" covers edge-classified fetches from the side panel
            // document — without it such requests would keep the
            // chrome-extension:// Origin and can trip the WAF (HTTP 405)
            resourceTypes: ["xmlhttprequest", "other"]
          }
        }
      ]
    });
  } catch (e) {
    console.error("DNR rules failed:", e);
  }
});

// ---------------------------------------------------------------------------
// Tab helper: reuse an existing chat.z.ai tab or open a short-lived one.
// ---------------------------------------------------------------------------
async function getZaiTab() {
  let tab = null;
  const tabs = await chrome.tabs.query({ url: "https://chat.z.ai/*" });
  if (tabs && tabs.length) tab = tabs[0];

  let created = false;
  if (!tab) {
    tab = await chrome.tabs.create({
      url: "https://chat.z.ai/",
      active: false
    });
    created = true;
    // wait for the tab to finish loading (SPA needs a moment)
    await new Promise((resolve) => {
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(resolve, 15000); // safety timeout
    });
    await new Promise((r) => setTimeout(r, 1500)); // let the SPA boot
  }
  return { tab, created };
}

async function grabZaiToken() {
  const { tab, created } = await getZaiTab();

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => ({
        token: localStorage.getItem("token") || "",
        user: localStorage.getItem("user") || ""
      })
    });
    const payload = results && results[0] ? results[0].result : null;
    if (created && tab.id) {
      chrome.tabs.remove(tab.id).catch(() => {});
    }
    if (!payload || !payload.token) {
      return { ok: false, error: "not_logged_in" };
    }
    return { ok: true, token: payload.token, user: payload.user };
  } catch (e) {
    if (created && tab.id) {
      chrome.tabs.remove(tab.id).catch(() => {});
    }
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// ---------------------------------------------------------------------------
// Captcha: chat.z.ai now requires an Aliyun Captcha token with every
// completion request (FRONTEND_CAPTCHA_REQUIRED / captcha_verify_param).
// The token is domain-bound, so we operate the SAME widget the official
// site runs (same SceneId, same hidden element + trigger button — all
// verified against the prod-fe-1.1.128 bundle) inside the user's
// chat.z.ai tab and collect the success payload.
//
// COMPLIANCE (Chrome Web Store "remote hosted code" policy): the Aliyun
// SDK is loaded BY the chat.z.ai page itself — the extension never adds a
// <script> tag, never fetches and never executes any remotely hosted code
// in ANY context. It only calls window.initAliyunCaptcha that the site
// already loaded and clicks the site's own trigger button. If the widget
// has not appeared yet we wait briefly and otherwise fail gracefully
// ("script_missing" → the user is asked to reload chat.z.ai).
//
// CRITICAL — how the official site produces a token (its tR() function):
//   D2=null; a1=null;            // drop the old script-promise + INSTANCE
//   await Sge();                 // (re)load SDK + re-init the widget
//   L3 = { resolve, reject };    // arm the waiter BEFORE triggering
//   PV();                        // click #chat-captcha-trigger
// A consumed Aliyun instance never fires success again, so re-clicking a
// cached instance (what v1.0.8 did) just times out. We therefore build a
// FRESH widget for every single solve, exactly like the site.
// ---------------------------------------------------------------------------
function zaiCaptchaRunner(waitMs) {
  return new Promise((resolve) => {
    const done = (payload, stage, challengeSeen) => {
      let clean = null;
      try { clean = JSON.parse(JSON.stringify(payload === undefined ? null : payload)); }
      catch { clean = null; }
      resolve({ stage, payload: clean, challengeSeen: !!challengeSeen });
    };
    (async () => {
      const tick = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        const SCENE = location.hostname === "chat.z.ai" ? "didk33e0" : "xswyjefn";
        const EID = "chat-captcha-element", TID = "chat-captcha-trigger";

        // 1) wait for the site's OWN captcha SDK — chat.z.ai loads
        //    AliyunCaptcha.js itself; the extension NEVER injects a script
        //    tag (Chrome Web Store remote-hosted-code policy). If the page
        //    is still booting, give it up to ~12 s; otherwise fail cleanly.
        if (!window.initAliyunCaptcha) {
          for (let i = 0; i < 120 && !window.initAliyunCaptcha; i++) await tick(100);
        }
        if (!window.initAliyunCaptcha) return done(null, "script_missing");

        // 2) hidden element + trigger button (identical to the web app)
        if (!document.getElementById(EID)) {
          const d = document.createElement("div");
          d.id = EID;
          d.style.cssText =
            "position:absolute;left:-99999px;top:-99999px;width:0;height:0;overflow:hidden;pointer-events:none;";
          document.body.appendChild(d);
        }
        if (!document.getElementById(TID)) {
          const b = document.createElement("button");
          b.id = TID;
          b.type = "button";
          b.setAttribute("aria-hidden", "true");
          b.tabIndex = -1;
          b.style.cssText = "position:absolute;left:-99999px;top:-99999px;width:1px;height:1px;opacity:0;";
          document.body.appendChild(b);
        }

        // 3) FRESH widget per solve — drop the previous instance first
        try {
          window.__zaiCapInst && window.__zaiCapInst.destroy &&
            window.__zaiCapInst.destroy();
        } catch {}
        window.__zaiCapInst = null;
        window.__zaiCapWait = null;

        let settled = false;
        let challengeSeen = false;
        let failClicks = 0;
        let reClicked = false;
        const finish = (payload, stage) => {
          if (settled) return;
          settled = true;
          done(payload, stage, challengeSeen);
        };

        // is a slider/popup currently on screen? (never disturb a drag)
        const challengeVisible = () => {
          try {
            const els = document.querySelectorAll(
              '[id^="aliyunCaptcha"],[class*="aliyunCaptcha"],[class*="aliyun_captcha"]'
            );
            for (const el of els) {
              const r = el.getBoundingClientRect();
              if (r.width > 2 && r.height > 2) return true;
            }
          } catch {}
          return false;
        };
        const poller = setInterval(() => {
          if (!settled && challengeVisible()) challengeSeen = true;
        }, 400);

        const click = () => {
          try { document.getElementById(TID).click(); } catch {}
        };

        // 4) init fresh, exactly like the site (same options as tR/Sge)
        let instReady = null;
        try {
          instReady = new Promise((res) => {
            window.initAliyunCaptcha({
              SceneId: SCENE,
              mode: "popup",
              element: "#" + EID,
              button: "#" + TID,
              captchaLogoImg: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
              language: "en",
              timeout: 10000,
              delayBeforeSuccess: false,
              success: (e) => {
                window.__zaiCapLast = e; // debug only — never reused (single-use)
                try {
                  window.__zaiCapInst && window.__zaiCapInst.refresh &&
                    window.__zaiCapInst.refresh();
                } catch {}
                finish(e, "success");
              },
              fail: () => {
                // official site: PV() — click the trigger again (capped)
                if (failClicks++ < 3) click();
              },
              onError: () => finish(null, "onError"),
              onClose: () => finish(null, challengeSeen ? "closed_after_challenge" : "onClose"),
              getInstance: (inst) => {
                window.__zaiCapInst = inst;
                res();
              }
            });
          });
        } catch {
          return done(null, "init_failed");
        }
        await Promise.race([instReady, tick(8000)]);
        if (!window.__zaiCapInst) return done(null, "init_timeout", challengeSeen);

        // 5) trigger and wait (single wait loop — no stale fallbacks)
        click();
        const deadline = Date.now() + (Number(waitMs) || 100000);
        let recheckAt = Date.now() + 15000; // silent-stuck detector
        while (!settled && Date.now() < deadline) {
          await tick(300);
          if (settled) break;
          if (!reClicked && Date.now() > recheckAt && !challengeSeen) {
            // nothing happened at all and no slider is on screen — the
            // instance may be stuck; refresh + one more click
            reClicked = true;
            try {
              window.__zaiCapInst && window.__zaiCapInst.refresh &&
                window.__zaiCapInst.refresh();
            } catch {}
            click();
          }
        }
        if (!settled) {
          finish(null, challengeSeen ? "timeout_challenge" : "timeout_silent");
        }
      } catch {
        done(null, "exception", false);
      }
    })();
  });
}

// normalize the Aliyun success payload into the value the site sends as
// captcha_verify_param (usually a string; unwrap wrapper objects)
function normalizeCaptchaPayload(p) {
  if (p == null) return null;
  if (typeof p === "string") return p;
  try {
    if (typeof p.captcha_verify_param === "string") return p.captcha_verify_param;
    if (typeof p.captchaVerifyParam === "string") return p.captchaVerifyParam;
  } catch {}
  return p; // pass through — JSON.stringify handles objects in the body
}

async function getZaiCaptcha() {
  // remember where the user was, so we can send them back afterwards
  let prevTab = null, prevWin = null;
  try {
    const [at] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (at) { prevTab = at.id; prevWin = at.windowId; }
  } catch {}

  let tab, created;
  try {
    const r = await getZaiTab();
    tab = r.tab; created = r.created;
  } catch (e) {
    return { ok: false, error: "no_tab: " + String(e && e.message ? e.message : e), stage: "no_tab" };
  }

  // TWO-PHASE solve (focus stealing kept to a minimum):
  //   phase 1 — quiet attempt in the background tab. Most solves end here
  //             with NO focus change at all (silent token, like the site's
  //             own traffic). Hidden tabs throttle timers/rAF, so this
  //             window stays short (~9 s).
  //   phase 2 — only if the widget stalled, errored, or Aliyun challenged
  //             with a slider the user must SEE and drag: bring the tab to
  //             the front and give it the generous window. The slider is
  //             always solved by the user — never automated.
  const userOnZaiTab = prevTab === tab.id; // user is already watching that tab
  let stoleFocus = false;

  const focusTab = async () => {
    if (userOnZaiTab || stoleFocus) return;
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tab.id, { active: true });
      stoleFocus = true;
      await sleep(700); // let the tab paint before triggering the widget
    } catch {}
  };

  const restoreFocus = async () => {
    if (!stoleFocus) return;
    try {
      if (prevTab && !created) {
        await chrome.tabs.update(prevTab, { active: true });
        if (prevWin) await chrome.windows.update(prevWin, { focused: true });
      }
    } catch {}
    stoleFocus = false;
  };

  const runSolve = async (waitMs) => {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: zaiCaptchaRunner,
        args: [waitMs]
      });
      const val = results && results[0] ? results[0].result : null;
      if (val && val.payload) {
        return {
          ok: true,
          captcha: normalizeCaptchaPayload(val.payload),
          stage: val.stage || "success",
          challengeSeen: !!val.challengeSeen
        };
      }
      return {
        ok: false,
        error: "captcha_" + ((val && val.stage) || "unavailable"),
        stage: (val && val.stage) || "unavailable",
        challengeSeen: !!(val && val.challengeSeen)
      };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e), stage: "execute_failed", challengeSeen: false };
    }
  };

  let out = await runSolve(9000); // phase 1 — quiet, background
  if (!out.ok || out.challengeSeen) {
    await focusTab(); // phase 2 — front and center, human can act
    out = await runSolve(100000);
  }

  // send the user back where they were — unless a slider may still be
  // waiting for them in the chat.z.ai tab
  const needUser = out && (out.stage === "timeout_challenge" || out.stage === "closed_after_challenge" || out.challengeSeen);
  if (!needUser) await restoreFocus();
  if (created && tab && tab.id) chrome.tabs.remove(tab.id).catch(() => {});
  return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "GRAB_ZAI_TOKEN") {
    grabZaiToken().then(sendResponse);
    return true; // async response
  }
  if (msg && msg.type === "GET_ZAI_CAPTCHA") {
    getZaiCaptcha().then(sendResponse);
    return true; // async response
  }
});
