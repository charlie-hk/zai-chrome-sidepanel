# Privacy Policy — Sidebar Agent for Z.ai

_Last updated: November 22, 2026_

## Overview

Sidebar Agent for Z.ai ("the extension") adds an AI assistant side panel that
uses the user's own Z.ai API key. The developer does **not** operate any
server, does **not** collect or store user data outside the user's own
browser, and does **not** receive copies of anything the extension processes.

## Data stored on your device

The side panel's local storage (an extension-scoped area readable only by this
extension) may hold:

- Your **Z.ai API key**, until you remove it (save an empty field in
  Settings → Advanced) or press **Disconnect**.
- Your settings (model choice, confirmation mode and similar switches).

The conversation shown in the panel lives in memory only; **Clear chat** or
**New chat** removes it. Everything is removed when you uninstall the extension.

## Data sent over the network

The extension sends requests **only** to `api.z.ai` (the official Z.ai API):

- Your messages and, if the current tab is attached, the visible text and the
  list of clickable elements of that page, so the model can answer.
- Your API key, in the request header, to authenticate as you.
- Results of actions you approved (for example the page text after a click).

Clicks, typing and scrolling are performed locally in your tab. The extension
sends nothing on its own initiative and contains no analytics, advertising,
tracking or logging service. It never fetches, injects or executes remotely
hosted code.

## Setting up your API key (only when you approve)

When you press **Connect** and approve the prompt, the extension opens your own
Z.ai API-keys page, presses the page's "Create API Key" button, reads the new
key that the page displays, and stores it as described above. It reads nothing
else from that page. You can delete the key on that page at any time.

## Third parties

The only third party is Z.ai, which receives your prompts and page text because
you use your own account and key. Its handling of that data is governed by
Z.ai's own privacy policy.

## Your control

- **Disconnect** removes the saved API key.
- **Clear chat** removes the panel's conversation.
- Uninstalling removes all locally stored data.

## Contact

Developed and maintained by **A.Amini**. For questions about this policy, use
the support email on the Chrome Web Store listing.

---

© 2026 A.Amini. All rights reserved.
