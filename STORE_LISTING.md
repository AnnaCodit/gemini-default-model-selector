# Chrome Web Store listing

## Title

Gemini Default Model Selector

## Summary

Set a default Gemini model and thinking level. The model list refreshes from your Gemini menu.

## Description

Start each visit to Gemini with your preferred model and thinking level already set.

FEATURES

• Choose from the models in your Gemini menu. New models appear in the extension dynamically as they become available to your account.
• If your preferred model disappears, the extension uses an available model and keeps your thinking level. Models locked to another plan are marked unavailable.
• Save Low, Medium, or High. When you choose Auto, your saved level is ready to use the next time you switch to a model with thinking controls.
• Press Alt+G (Option+G on Mac) to open Gemini and focus the prompt. You can change the shortcut in Chrome's extension settings.

HOW TO USE

Open Gemini once to load your model list, then click the extension icon and choose your defaults. Chrome needs to allow the extension to run on gemini.google.com for it to apply them on future visits. You can still change models directly in Gemini for the current tab.

PRIVACY

The model list and your review reminder preference stay in your browser. Chrome can sync your model and thinking preferences across devices when Chrome Sync is enabled. The extension does not collect prompts, chat history, or analytics.

Gemini Default Model Selector is an independent extension. Gemini is a trademark of Google LLC.

## Single purpose

Remember and apply the user's preferred Gemini model and thinking level on gemini.google.com.

## Permission justification

- `storage`: Stores model and thinking preferences in Chrome Sync and keeps the model list and review reminder preference locally.
- `https://gemini.google.com/*`: Reads and operates Gemini's model controls only on Gemini pages.

## Privacy disclosure

The extension does not collect, sell, or transmit personal data. It uses `chrome.storage.sync` for model and thinking preferences and local browser storage for the Gemini model list and review reminder timing and dismissal.

## Store images

- [Store icon](assets/icons/icon-128.png)
- [Small promotional image, 440 × 280](assets/store/promo-small-440x280.png)
- [Screenshot 1, 1280 × 800 — current model list](assets/store/screenshot-1-settings-1280x800.png)
- [Screenshot 2, 1280 × 800 — Auto and saved thinking level](assets/store/screenshot-2-applied-1280x800.png)

Editable SVG sources for the icon, screenshots, and promotional tile are included under `assets/icons` and `assets/store/source`.

To regenerate all transparent icon sizes (16, 32, 48, and 128 px) from the SVG, run `python assets/icons/render-icons.py`. The script also updates the icon copies used by the screenshot sources.

Both screenshots use the current popup with an example Gemini catalog. The light screenshot shows 4 Neon and High. The dark screenshot shows Auto with Medium saved. The small promotional tile uses the extension icon and a model selection motif.

To regenerate the screenshots and the promotional tile, run:

```powershell
python assets/store/source/render-store-images.py
```

The renderer requires Python with `playwright` and `Pillow`, plus an installed Chrome or Edge browser. It uses an isolated browser with example preferences. It does not connect to the user's Chrome profile or Gemini account.
