# Sidebar Agent for Z.ai

Chrome side panel (Manifest V3) that lets Z.ai GLM models read the page you are on and, with your
approval, click, type, scroll, open pages, take screenshots and upload files. It talks to the
official Z.ai API with the user's own API key (`https://api.z.ai/api/paas/v4/chat/completions`).

## Install

**From the Chrome Web Store (recommended, once the listing is live):** search
"Sidebar Agent for Z.ai" on the Chrome Web Store and click *Add to Chrome*.
(The store link will be added here after the listing is approved.)

**Developer mode (from this repository):**

1. `chrome://extensions` → Developer mode → **Load unpacked** → select this folder.
2. Open the panel, press **Connect** and approve. See `USER_GUIDE.md`.

## How it is built

- `background.js`: opens the side panel on icon click, nothing else.
- `panel/sidepanel.js`: chat UI, API streaming (retries, pacing, free-model alternation), agent loop.
- `panel/keycreator.js`: runs in the user's own Z.ai key page, only after approval, to create a key.
- `agent/agent.js`: content script that reads the page and performs click/type/scroll/upload.
- Permissions: `sidePanel`, `tabs`, `scripting`, `activeTab`, host access to all sites (the agent works on
  the user's tabs) and `api.z.ai`.

## Status and limits

- **Not tested against the live Z.ai services or a real Chrome.** Tested with a mock server, a stubbed
  `chrome.*` and mock pages (60 + 5 checks, see the changelog).
- The "create key" step uses guessed button labels and key format; it falls back to pasting a key.
- Free models (`glm-4.7-flash`, `glm-4.5-flash`) are shared and often busy; paid models need balance.
- The panel conversation is lost when the panel is closed.

## Changelog

### v1.0.36: official API only; fewer and smaller requests

- **Removed** the unofficial chat.z.ai session mode: no session token, request signing, header
  rewriting, captcha automation, manual token or chat-session list. The extension now has one transport,
  the official API, and no `declarativeNetRequest` permission.
- **Smaller requests:** snapshot text 7000 → 5000 characters (4000 sent) and 80 → 60 elements; history
  budget 24000 → 14000; the stored page snapshot is no longer re-sent every step when the latest tool
  result already contains it; the priming message pair was dropped. Measured on a synthetic page:
  8765 → 5345 characters per snapshot. The 8.6k-character system prompt is unchanged.
- **Fewer requests:** after a click or key press the panel reads the page itself and returns it in the same
  tool result, so the model does not spend a step on a separate `read` (expected to save one request per
  action when the model would have read afterwards; not measured on real tasks).

### v1.0.34 — "service may be temporarily overloaded" (HTTP 429)

- That answer means shared capacity is full (the free API models are shared by every free user), not that
  the key or the extension is broken. API mode now retries up to 6 times with growing waits (2 to 16 s,
  `Retry-After` honoured), alternates between the two free models after the second failure, shows one status
  line while waiting, and can be stopped during the wait.
- Consecutive requests are spaced at least 1.2 s apart (the agent used to fire its steps back to back).
- `glm-5.3-flash` was added to the list (paid; id unverified: use "Custom model id" if it is rejected).
- Not changed: the website's own free quota (chat.z.ai with 5.x models) is not available through the API.

### v1.0.33 — free model by default; no more dead end on an empty balance

- A new Z.ai account has no balance, and the default model (`glm-5.3`) is a paid one, so the first
  message failed with HTTP 429 "Insufficient balance". API mode now starts on `glm-4.7-flash`, which
  docs.z.ai/guides/overview/pricing lists as free (with `glm-4.5-flash`), and keeps a model the user
  picked explicitly.
- If a paid model returns "insufficient balance", the panel switches to a free model by itself, says
  so in one status line, remembers it, and does not retry the paid model. Rate-limit 429s are still
  retried.
- Not checked: the free models' rate limits, and whether they follow the agent protocol as well as
  `glm-5.x` do (opinion, no data: they are smaller, so expect weaker multi-step browsing).

### v1.0.32 — Connect creates the key for you (after approval)

- **Connect** asks once, opens the user's Z.ai key page, presses its visible "Create API Key" button,
  names the key, confirms, reads the key the page shows and saves it locally. No private endpoints
  are called, nothing is replayed from a session token, and captchas are left to the user.
- **Not verified against the real page.** The button labels and the key format are guesses
  (`xxxxxxxx….yyyy`); it was tested only on mock pages (5 cases). If the page differs, Connect says so
  and the user pastes a key in Settings → Advanced.
- Settings were reduced to Model, "Ask before acting", Clear chat and Disconnect; everything else is
  under "Advanced".

### v1.0.31 — guided API-key connect; session mode is opt-in

- **Connect** now opens the Z.ai key page, opens Settings and focuses the key field; the user creates
  a key in their own account and pastes it once (the key is then kept in this browser and reused).
  The extension does not fetch or create keys by itself and never reads the key page.
- The chat.z.ai session / captcha mode is **off by default**; it is a checkbox in Settings.
- Flash model ids were added to the list from third-party reports that they are free; the ids and the
  pricing were not checked on docs.z.ai.

### v1.0.30 — fixes for "no access" refusals, lag and reconnecting

**Not tested against the live Z.ai services or a real Chrome.** Checked with a mock server and a
stubbed `chrome.*` (27 checks); the original code fails 11 of the matching checks.

- **Official API mode (new, recommended).** Save a Z.ai API key in Settings. Requests then go to
  `api.z.ai/api/paas/v4/chat/completions` with a normal Bearer key: no captcha, no signature, no
  header rewriting, no WAF retries. The system prompt is sent as a real `system` message to the
  public API. Whether this ends the "I have no access" replies has **not** been verified with a real
  key; those replies came from the model, and the chat.z.ai website mode cannot be trusted to honour
  the extension's instructions. The captcha / signature / WAF code of the session mode was not
  touched and was not improved.
- **navigate / screenshot** now run in the panel: `navigate` uses `chrome.tabs.update`, waits for the
  load and returns the loaded page; it works from the New Tab page (before, the agent needed an
  attachable page first and answered "no attachable page"). `screenshot` captures the tab you are on
  instead of comparing against a stale URL (before, any navigate or SPA route change made it fail).
- **Refusal guards** only apply to short replies and no longer match ordinary phrases such as
  "ندارم", "only read", "done".
- **Lag:** streaming re-renders at most every 80 ms; reasoning text is appended instead of rebuilt;
  a stream that goes silent for 60 s is cancelled with a clear message (API mode).
- **Reconnect:** the panel reconnects on open (API key saved, or you connected before). Before, the
  manual token was erased on connect, so every panel open started disconnected.
- Still true: closing the side panel clears the conversation; screenshots need a normal http(s) tab.

### v1.0.29 — the request was too big for the edge (WAF)

Every step re-sent the **full page snapshot of every earlier step**. A 12-step
task carried ~171 KB in one request body, and chat.z.ai's Aliyun WAF started
rejecting it mid-task — which is why longer runs failed more often than short
ones, and why raising the step budget looked like a regression.

- History compaction: only the two newest snapshots are sent verbatim, older
  ones become a one-line stub, and the history stops at a 24 KB budget (newest
  turns win). Measured on a 14-step history: **171 KB → 35 KB**.
- The lean retry path uses the same compaction, so a WAF retry is genuinely
  small instead of slightly smaller.

### v1.0.28 — enough steps to finish, and no stalling

- The step budget went from 12 to 24: a real post (open LinkedIn → read → open
  the composer → upload the PNG → type the draft → click Post → verify) needs
  about 15. v1.0.27 stopped two steps before publishing.
- A repeated identical `click` / `type` / `press` / `upload` is now skipped with
  a note instead of running again — the model was re-sending the same draft and
  burning the budget.
- `extract` sent with a `prompt` instead of a CSS `query` now explains the
  difference and points at `read`.

### v1.0.27 — targets by ref / id / visible label (click actually runs)

The model was sending `{"action":"click","ref":"e29"}` and
`{"element":"Start a post button"}`. The parser read those blocks fine, but the
action layer only looked at `target`, so every click was rejected with
"element not found" until the step budget ran out.

- `ref`, `refId`, `id`, `elementId`, `eid`, `locator` and `element` are now
  folded into `target` before the action runs — the approval dialog shows the
  canonical form.
- `target` also accepts the element's `id` attribute (`editor`) and the visible
  label (`Start a post`). Matching is tiered (exact → prefix → all words), so
  "Start a post button" finds the button whose `aria-label` is "Start a post".
- When a label matches more than one element the action fails **with the
  candidate ids listed**, so the next step can pick one instead of guessing.
- `text` accepts `value` / `content`, and `files` accepts `file` / `filename`.
- The step-limit notice reports the real limit.

### v1.0.26 — based on 1.0.24: reliable typing, real screenshots, no silent refusal

Built from the **1.0.24** code base; the 1.0.25 chat/prompt rewrite was dropped.

- **Multi-paragraph text really lands.** `type` now selects the target editor and
  inserts the whole text through Chrome's editing pipeline, then reads it back
  character by character. If the page truncates or rejects the draft, the action
  fails loudly instead of reporting success (tested on a rich-text editor and a
  textarea with Persian + emoji + line breaks).
- **Screenshots work without a toolbar click.** The manifest now requests
  `<all_urls>` (the same install warning as before), which is what
  `captureVisibleTab` requires. The capture is re-checked before and after: if
  the tab changed, the image is discarded rather than attached to the wrong post.
- **A refusal is no longer an answer.** When the model says it has no browser
  tools, or describes an action it never ran, the extension now answers with one
  correction, then asks for a single literal `{"action":"read"}` line, and only
  then stops with an explicit error. Nothing is left looking as if it succeeded.
  The denial detector was also rewritten — it missed the most common phrasing
  ("I don't have a click or type tool").
- **`click` no longer reports success**, only that the click was dispatched.
- **A silent tab cannot freeze the panel**: every page action has an 8 second
  limit.

### v1.0.24 — loose action text + web-fetch drift fixed

- The model sometimes writes actions as **plain prose** instead of a fenced
  JSON block (e.g. `action navigate url: https://…` or
  `action screenshot بگیر`). These are now parsed and really executed —
  previously they were shown as dead text and nothing happened.
- The native `web-fetch` tool returns empty in this session; the prompt now
  explicitly forbids it and the guard detects that drift and pushes the model
  back to `navigate` + `read` (which really work).
- One action per turn: the first runnable action in a reply is executed, so a
  chained "navigate … screenshot …" advances one correct step at a time.

### v1.0.23 — real screenshots + verified capabilities

- **Screenshot action added** — `{"action":"screenshot"}` captures the visible
  tab as a real PNG (Chrome `captureVisibleTab`), displays it in the chat with a
  download link, and registers it in the 📎 bridge so it can be uploaded into
  a post's image input. Chrome cannot capture browser/protected pages or tabs
  with DevTools open; it captures the visible viewport, not the whole page.
- **All actions tested** — `read`, `click`, `type`, `press`, `scroll`, `extract`,
  `navigate`, `upload` were each invoked against a mocked page and verified to
  return success; the screenshot capture + data-URL→File path was tested too.
- **Capability-denial guard extended** — now catches the exact Persian denial
  wording reported by users ("من ابزار اسکرینشات ندارم… فقط جستجوی وب…").

### v1.0.22 — capability-denial fix

- **The agent can no longer claim it has no browser control** — GLM sometimes
  drifted back to its plain-chat persona and said "I only have web search /
  no browser automation / I can't click". The system prompt no longer names
  those (naming them triggered the drift), and a guard now detects that
  denial and forces the model to either emit a real action block or name a
  concrete blocker.
- **Visible progress while retrying** — a single updating status line is on
  by default again so a captcha/capacity retry looks like "working", not
  "hung" (still only one line, never a wall of green boxes; turn it off in
  Settings for a quiet chat).

### v1.0.21 — bug fixes

- **Green status spam fixed** — captcha / "at capacity" / WAF retry
  notices no longer flood the chat with green boxes; they are collapsed
  into a single line that updates in place and disappears when the reply
  finishes. Turn it off in **Settings → Show retry / captcha status** for
  a completely quiet chat.
- **Raw tool JSON removed** — chat.z.ai's native `<glm_block>` markup
  is stripped from displayed and stored text, so the chat shows clean
  responses instead of `{"mcp_server":{"name":"action_click…"}}`.
- **Actions now really execute** — native MCP calls are parsed and
  converted into the extension's own `action` blocks, then executed
  for real in the active tab. The model can no longer claim it
  clicked/typed/sent something without actually doing it.

### v1.0.18 — initial public release

## License & ownership

© 2026 **A.Amini** — creator & owner. All rights reserved.
