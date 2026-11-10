# Privacy Policy — Sidebar Agent for Z.ai

_Last updated: November 10, 2026_

## Overview

Sidebar Agent for Z.ai ("the extension") is a browser extension that adds
an AI assistant side panel connected to the user's own chat.z.ai account.
The developer does **not** operate any server, does **not** collect or
store any user data outside the user's own browser, and does **not**
receive copies of anything the extension processes.

## Data stored on your device

The extension is local-first. While you are connected, your chat.z.ai
session token is held in the side panel's **memory** only; it is not
written to disk and it disappears when the panel or the browser closes.
Additionally, the side panel's own local storage inside your browser (an
extension-scoped area readable only by this extension) may hold:

- A session token **you pasted manually** — saved until Connect succeeds
  or until you press **Disconnect**.
- Your settings (e.g., model choice, confirmation mode).
- Your panel conversation history lives in the panel's memory for the
  current session only; **Clear chat** (or **New chat**) removes it
  immediately.

This data never leaves your machine except as described below, is never
sold, and is removed when you uninstall the extension or press
**Disconnect** in the Settings drawer.

## Data sent over the network

When you use the panel, the extension sends requests **only** to
`chat.z.ai`:

- Your question, plus — if you attached the current tab — the visible
  text of that page, is sent to chat.z.ai so the AI can answer.
- Your session token is sent in the request headers to authenticate as
  you.
- Page actions you approve (clicks, typing, scrolling) are performed
  locally in the page; only page text relevant to your request is sent
  to chat.z.ai.

The extension communicates with no other servers, sends nothing on its
own initiative, and contains no analytics, no advertising, no tracking
and no logging service. It never fetches, injects or executes remotely
hosted code in any context (extension pages or web pages).

## Captcha verification

When chat.z.ai requires a verification, the extension operates the
verification widget **that the chat.z.ai page itself has loaded** inside
your own chat.z.ai tab — the same widget the official web app uses on
every message send. The verification result is attached only to your
request to chat.z.ai. The extension never sends anything to the
verification provider or any other party.

## Third parties

The only third-party service involved is Z.ai (chat.z.ai), which receives
your prompts and page text because you are using your own account there.
Their handling of that data is governed by Z.ai's own privacy policy.

## Your control

- **Disconnect** (Settings) removes the saved token and disconnects the
  panel from your Z.ai account.
- **Clear chat** (Settings) removes the panel's conversation history.
- Uninstalling the extension removes all locally stored data.

## Contact

This extension is developed and maintained by **A.Amini**. For questions
or concerns about this policy, use the support email shown on the Chrome
Web Store listing.

---

© 2026 A.Amini — creator & owner of Sidebar Agent for Z.ai. All rights reserved.
