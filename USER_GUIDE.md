# Sidebar Agent for Z.ai — User Guide

© 2026 A.Amini — creator & owner. All rights reserved.

An unofficial "Claude for Chrome"-style extension for **Z.ai** — a side
panel next to the page you are browsing, connected to **your own logged-in
chat.z.ai account**. It reads the page and can click / type / scroll for
you, always asking before it acts.

## Install (Chrome)

1. Extract the `zai-chrome-sidepanel` folder.
2. Go to `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select that folder.
5. Pin the extension icon and click it — the side panel opens.

## Connect your account

1. Open `https://chat.z.ai` in a normal tab and make sure you are logged in.
2. In the panel, click **Connect** — it picks up the session token your
   browser already has for chat.z.ai (`localStorage.token`).
3. The panel greets: **"Now you can chat in your language."** — write in
   any language and the agent replies in the same one.
4. If Connect fails: refresh the chat.z.ai tab and retry, or open ⚙
   Settings and paste the token manually (F12 → Console →
   `localStorage.token` in the chat.z.ai tab).

## Using the agent

- Ask anything about **the current page** — the panel attaches a live
  snapshot (visible text + interactive elements with ids like `e12`).
- Tell it to **act**: "type … and press Enter", "click the first result",
  "scroll down", "open github.com/…" — the agent replies with action
  blocks the extension executes for real.
- **Confirm mode** (default on): every click/type shows an
  Approve / Skip card first. Turn it off in ⚙ Settings for automatic mode.
- **Sessions**: the 🗂 button lists your chat.z.ai conversations — resume
  one or start a new chat; everything appears in your account history too.
- **🛡 safety rails**: payments, passwords, deleting data and sending
  messages on your behalf are never done unless you explicitly asked for
  exactly that.

## 📎 Attach files — publish a local project (e.g. to GitHub)

1. Click **📎** in the composer → **📁 Folder…** (a whole project) or
   **📄 Files…**. Text files are picked up; `node_modules`, `.git` and
   binaries are skipped automatically. Right-click 📎 to clear.
2. Ask for what you want: *"put this project on GitHub"*, *"which file
   handles the captcha?"*, *"fix the bug in sidepanel.js"* — the agent
   sees the file tree (and, for small projects, the full contents).
3. For uploads the agent uses the `upload` action — the real files are
   handed to the page's own file picker. On GitHub it will create the
   repository at `github.com/new` and commit folder by folder through the
   upload pages. Every step still asks for your approval (confirm mode).

## What the status messages mean

| Message | Meaning |
|---|---|
| 🔐 Z.ai wants a captcha check… | The server demanded a security check; the extension solves the Aliyun widget in your chat.z.ai tab automatically. If a slider appears there, drag it once. |
| 🔐 Solving the Z.ai captcha check… | Same, pre-solved before the next request. |
| ⏳ …is at capacity — waiting… | Server-side load; the panel waits and retries, then may switch to the fallback model (glm-5.3 ↔ glm-5.2). |
| 🛡 Z.ai's protection layer blocked… | The Aliyun WAF returned a block page; the panel reloads your chat.z.ai tab (this runs the WAF's own check) and retries. |
| ✔ Signed build verified (console) | The build is the original, unmodified one signed by A.Amini. |
| ⚠ Build integrity check failed (console) | This copy was modified or corrupted — re-extract the original zip. |

## Notes

- Unofficial project — it may break when Z.ai changes its site; use it
  with your own account at your own discretion.
- Requests go straight from your browser to chat.z.ai. Nothing is sent
  anywhere else (see `PRIVACY_POLICY.md` in the store package).
- Developer & rights holder: **A.Amini**.
