# Chrome Web Store listing

## Title

Gemini Default Model Selector (UPDATED)

## Summary

Automatically applies your preferred Gemini model and Extended thinking setting when Gemini opens.

## Description

Choose the Gemini model you want to use by default and keep Extended thinking enabled or disabled across visits.

Gemini Default Model Selector automatically applies your saved preferences when you open gemini.google.com. You can still switch models manually for the current tab—the extension will not override that choice until the page is reloaded.

Features:

- Choose 3.5 Flash-Lite, 3.6 Flash, or 3.1 Pro.
- Save the Extended thinking setting.
- Apply saved preferences automatically when Gemini opens.
- Keep manual model changes for the current tab.
- Return focus to the prompt after switching.
- Sync preferences with Chrome Sync.
- Run only on gemini.google.com.
- No analytics, ads, or external data transmission.

This extension is not affiliated with Google. Gemini is a trademark of Google LLC.

## Single purpose

Remember and apply the user's preferred Gemini model and Extended thinking setting on gemini.google.com.

## Permission justification

- `storage`: Stores the selected model identifier and Extended thinking preference in Chrome Sync.
- `https://gemini.google.com/*`: Reads and operates Gemini's model controls only on Gemini pages.

## Privacy disclosure

The extension does not collect, sell, or transmit personal data. It stores only the selected model identifier and a Boolean Extended thinking preference through `chrome.storage.sync`.
