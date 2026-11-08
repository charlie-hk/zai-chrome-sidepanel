# Privacy Policy — Sidebar Agent for Z.ai

_Last updated: November 7, 2026_

## Overview

Sidebar Agent for Z.ai ("the extension") is a browser extension that adds
an AI assistant side panel connected to the user's own chat.z.ai account.
The developer does **not** operate any server, does **not** collect or
store any user data outside the user's own browser, and does **not**
receive copies of anything the extension processes.

## Data stored on your device

The extension stores the following in your browser's local extension
storage (`chrome.storage.local`):

- Your chat.z.ai session token (used only to authenticate to chat.z.ai on
  your behalf).
- Your settings (e.g., model choice, confirmation mode).
- Your panel conversation history.

This data never leaves your machine except as described below, is never
sold, and is removed when you uninstall the extension (or use the
"Disconnect" / "Forget token" controls in the panel).

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

The extension communicates with no other servers. It contains no
analytics, no advertising, no tracking, no logging service, and does not
execute remotely hosted code.

## Third parties

The only third-party service involved is Z.ai (chat.z.ai), which receives
your prompts and page text because you are using your own account there.
Their handling of that data is governed by Z.ai's own privacy policy.

## Your control

- "Disconnect" removes the stored token.
- "Clear chat" removes panel conversation history.
- Uninstalling the extension removes all locally stored data.

## Contact

This extension is developed and maintained by **A.Amini**. For questions
or concerns about this policy, use the support email shown on the Chrome
Web Store listing.

---

© 2026 A.Amini — creator & owner of Sidebar Agent for Z.ai. All rights reserved.
