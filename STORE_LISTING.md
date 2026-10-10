# Chrome Web Store listing

## Title

Gemini Default Model Selector

## Summary

Automatically applies your preferred Gemini model and thinking level when Gemini opens.

## Description

Choose the Gemini model and thinking level you want to use by default across visits.

Gemini Default Model Selector automatically applies your saved preferences when you open gemini.google.com. You can still switch models manually for the current tab—the extension will not override that choice until the page is reloaded.

✨ FEATURES

- Choose 3.5 Flash-Lite, 3.8 Flash, or 3.1 Pro.
- Graceful fallback to 3.7 Flash while Google progressively rolls out 3.8 Flash.
- Save a Low, Medium, or High thinking level independently of Gemini's interface language.
- Support the legacy Extended thinking toggle: Low disables it; Medium and High enable it.
- Apply saved preferences automatically when Gemini opens.
- Keep manual model changes for the current tab.
- Return focus to the prompt after switching.
- Sync preferences with Chrome Sync.
- No analytics, ads, or external data transmission.

💥 BONUS
- Open a new Gemini tab and focus its prompt with Alt+G
- Change shortcut in Chrome extensions settings


This extension is not affiliated with Google. Gemini is a trademark of Google LLC.

## Single purpose

Remember and apply the user's preferred Gemini model and thinking level on gemini.google.com.

## Permission justification

- `storage`: Stores the selected model identifier and thinking level in Chrome Sync, retaining a compatible legacy Boolean preference.
- `https://gemini.google.com/*`: Reads and operates Gemini's model controls only on Gemini pages.

## Privacy disclosure

The extension does not collect, sell, or transmit personal data. It stores only the selected model identifier, thinking level, and compatible legacy Boolean preference through `chrome.storage.sync`.

## Store images

- Store icon: `assets/icons/icon-128.png`
- Small promotional image: `assets/store/promo-small-440x280.png`
- Screenshot 1: `assets/store/screenshot-1-settings-1280x800.png`
- Screenshot 2: `assets/store/screenshot-2-applied-1280x800.png`

Editable SVG sources for the icon and screenshots are included under `assets/icons` and `assets/store/source`.
