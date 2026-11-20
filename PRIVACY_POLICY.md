# Privacy Policy for Gemini Default Model Selector

**Last Updated:** November 21, 2026

## 1. Overview
This Privacy Policy describes how the **Gemini Default Model Selector** Chrome Extension ("Extension", "we", "us", or "our") handles your data. We are committed to protecting user privacy. This Extension is designed to operate locally on your browser with strict data minimization principles.

## 2. Data Collection and Usage
**We do not collect, transmit, store on external servers, or sell any personal data, sensitive information, browsing history, prompts, or communication content.**

### Stored Data
The Extension stores these non-personally identifiable preferences on your device:
- Selected preferred Gemini model identifier (e.g., `3.5 Flash-Lite`, `3.8 Flash`, `3.1 Pro`)
- Selected thinking level (`low`, `medium`, or `high`) and its compatible legacy Extended thinking state (enabled/disabled)

These preferences are saved using Chrome's native `chrome.storage.sync` API. If you are signed into Google Chrome with Chrome Sync enabled, Chrome may synchronize these preference settings across your logged-in browser instances using Google's infrastructure. We do not have access to your Google Account or external storage servers.

The Extension also caches model names, identifiers and availability as shown in the Gemini model menu. This cache stays in the local extension storage in your browser and is used to show the list of models in the popup.

The Extension stores when to show the review reminder and whether you dismissed it in local extension storage. These values stay in your browser.

## 3. Extension Permissions
The Extension requests the following browser permissions strictly for core functional purposes:

* **`storage`**: Stores your model preferences, the local list of models, and your review reminder preference.
* **`https://gemini.google.com/*`**: Reads Gemini's model menu and applies your saved model settings automatically. It does **not** read, save, track, or transmit your conversation history, prompts, or account information.

## 4. Data Sharing and Selling
- **No Third-Party Transfer:** We do not sell, license, trade, or transfer any user data to third parties.
- **No Advertising or Tracking:** We do not use third-party analytics, tracking cookies, advertising scripts, or telemetry.
- **No External Data Transmission:** No data is transmitted to external servers operated by us or any third party.

## 5. Compliance with Chrome Web Store User Data Policy
The Extension complies strictly with the [Google Chrome Web Store Developer Program Policies](https://developer.chrome.com/docs/webstore/program-policies/), including the Limited Use requirements.

## 6. Disclaimer and Third-Party Services
Gemini Default Model Selector is an independent tool and is **not affiliated, endorsed, sponsored, or associated with Google LLC or Google Gemini**. Gemini is a trademark of Google LLC.

## 7. Changes to This Privacy Policy
We may update this Privacy Policy from time to time. Any changes will be posted by updating the "Last Updated" date at the top of this document.

## 8. Contact Us
If you have any questions or concerns regarding this Privacy Policy, please contact the developer via:
- GitHub Repository / Contact: [Insert GitHub Repository or Email Link]
