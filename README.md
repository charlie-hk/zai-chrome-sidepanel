# Sidebar Agent for Z.ai (Chrome MV3)

An unofficial "Claude-for-Chrome"-style side panel for **Z.ai**. It opens
next to any page, connects to **your own logged-in chat.z.ai account**,
reads the page, and can click / type / scroll for you — always asking
before it acts.

![what it does](https://img.shields.io/badge/browser-Chrome%20MV3-blue)

## Features

- **Side panel UI** (Chrome native `sidePanel` API), dark theme, English.
- **Account connection** — the *Connect* button picks up the session token
  your browser already has for chat.z.ai (`localStorage.token`). Chats you
  start here also appear in your normal chat.z.ai history.
- **Session picker** — lists your existing chat.z.ai conversations, lets
  you resume one or start a new chat (client-generated UUID, same as the
  official web app does).
- **Page awareness** — attaches a snapshot of the active tab (visible text
  + tagged interactive elements `e1…eN`) to every message.
- **Agent actions** — `click`, `type`, `press`, `scroll`, `extract`, `read`,
  `navigate`, `upload` via a JSON action protocol; GLM decides, the panel
  executes.
  The parser repairs common model JSON mistakes (smart quotes, trailing
  commas, raw newlines inside strings, truncated/unclosed blocks) and, if a
  block is still unreadable, asks the model to re-emit it instead of
  stopping the agent.
- **📎 File bridge** — attach local files or a whole project folder; the
  agent reads them and can push them into any web upload form with the
  `upload` action (e.g. publish the project to GitHub via the web UI —
  repo creation, per-folder commits — without git or tokens). The model
  only names paths; file bytes go straight from the extension to the page.
- **Confirm mode (default ON)** — every click/type/upload shows an
  Approve / Skip card before touching the page.
- **Streaming** — SSE is parsed exactly like the web app does
  (`edit_content` / `edit_index` / `delta_content`), with GLM reasoning
  shown in a collapsible 💭 block.
- **Signed requests** — implements chat.z.ai's request signature
  (HMAC-SHA256, bucketed time key) and `x-fe-version` scraping, so requests
  look like the ones the official frontend sends.
- Guest fallback (limited models) and manual-token fallback are built in.

## Install (Chrome, developer mode)

1. Download / unzip this folder.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the folder
   (`zai-chrome-sidepanel`).
5. Pin the extension, then click its icon — the side panel opens.

## First run

1. Make sure you are logged in to **chat.z.ai** in the same Chrome profile.
2. In the panel click **Connect**.
   - The extension briefly opens (or reuses) a chat.z.ai tab, reads your
     session token, and closes it. You should see `Connected: <your name>`.
   - If Connect fails (rare), copy the token manually: open chat.z.ai →
     F12 → Application → Local Storage → key `token` → paste it in
     **Settings → Manual token** → Save → Connect.
3. Pick a model in **Settings** (default `glm-5.3`; hit ↻ to fetch the live
   model list from your account).
4. Open any page, click **Sessions → + New chat**, and ask away:
   - "Summarize this article"
   - "Find the pricing section and tell me the cheapest plan"
   - "Fill the search box with 'nvda earnings' and press search"
     → panel shows an Approve card before clicking.

## Captcha (automatic)

chat.z.ai may answer with `FRONTEND_CAPTCHA_REQUIRED` (an Aliyun captcha is
required for the request). The extension then runs **the site's own widget**
(same SceneId, same SDK URL and options as the official `tR()` flow in the
`prod-fe` bundle) inside your chat.z.ai tab:

- the chat.z.ai tab is brought to the front (hidden tabs throttle timers and
  you could not see a slider anyway);
- usually the smart verification passes silently in 1–3 s and focus returns
  to your previous tab;
- if a **slider** appears, drag it once — the solve is picked up
  automatically (up to ~100 s);
- once the server has demanded a captcha, a **fresh single-use token is
  solved before every request** (mirroring the official site's
  `enable_captcha` behavior), so later messages succeed on the first try;
- failures are reported with a specific stage (`script_missing`,
  `init_failed`, `timeout_challenge`, `onClose`, `onError`, `no_tab`) and a
  matching hint instead of a generic error.

## How it works (protocol summary)

| Purpose | Endpoint |
| --- | --- |
| Model list | `GET /api/models` |
| Session list | `GET /api/v1/chats/?page=1` |
| Session messages | `GET /api/v1/chats/{id}` |
| Chat completion (SSE) | `POST /api/v2/chat/completions?…&signature…` |
| Guest fallback | `POST /api/v1/auths/guest`, `GET /api/v1/auths/` |

Every completion request carries:

- headers `authorization: Bearer <localStorage token>`,
  `x-fe-version: prod-fe-x.y.z` (scraped from the homepage),
  `x-signature` (HMAC-SHA256 over
  `sortedPayload|base64(lastUserMessage)|timestamp` with a bucketed key
  derived from the web app's salt),
- body `{model, chat_id, messages, signature_prompt, stream:true,
  features:{…}}`.

`chat_id` is generated client-side (UUID) exactly like the official web
app, so conversations materialize inside your real account history.

Origin / Referer headers are aligned to `https://chat.z.ai` for extension
requests via `declarativeNetRequest` session rules.

## Security & privacy

- Your token stays in the browser: it is read from chat.z.ai, kept in the
  extension's local storage, and sent **only** to `https://chat.z.ai`.
- No analytics, no third-party servers, no telemetry.
- Confirm mode is on by default; the agent never sees pages you haven't
  opened the panel on.

## Disclaimer

This is an **unofficial** integration built on chat.z.ai's internal web
API. It can stop working whenever Z.ai changes its frontend, and it may
not be compatible with the Z.ai terms of service — use it with your own
account, at your own discretion, for personal automation. Don't use it
for scraping at scale or abuse of any kind.

## License & ownership

© 2026 **A.Amini** — creator & owner. All rights reserved.

This is a **signed build**: the packaged files are checksummed and signed
with an ECDSA P-256 key held by the author (see `LICENSE`), and the
background worker verifies that signature on every startup. Modified or
corrupted copies announce themselves in the console.
