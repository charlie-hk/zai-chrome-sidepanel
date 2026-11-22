# Sidebar Agent for Z.ai — user guide

A side panel that can read the page you are on and, with your approval, click,
type, scroll, open pages and take screenshots. It uses **your own Z.ai API key**.

## First start

1. Click the extension icon to open the panel, then press **Connect**.
2. Approve the prompt. The extension opens your Z.ai API-keys page, creates a key
   and keeps it in this browser. If it cannot (you are not signed in, or the page
   changed), create a key there yourself and paste it in **⚙ Settings → Advanced →
   Z.ai API key**.
3. Ask something. The panel starts on a free model (`glm-4.7-flash`).

## Good to know

- **Free models are shared** and can answer "service overloaded". The panel waits,
  retries and alternates between the two free models. Paid models need balance on
  your Z.ai account; if it is empty the panel switches to a free model by itself.
- **Ask before acting** (Settings) shows every click, typing or upload for approval.
- Screenshots and "read this page" need a normal http(s) tab, not Chrome's own pages
  or the Web Store.
- Closing the panel clears the conversation. **Disconnect** removes the saved key.

## Messages

| Message | Meaning |
|---|---|
| Z.ai is busy (HTTP 429), retrying in N s | Shared capacity is full. Wait, or pick a paid model. |
| No balance for … switching to the free model | Your balance is empty for that model. |
| The API key was rejected | Key deleted or wrong. Save a new one in Settings → Advanced. |
