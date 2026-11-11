importScripts("shared.js");

(function initializeBackground() {
  "use strict";

  const core = globalThis.GeminiDefaultModelCore;

  const OPEN_GEMINI_COMMAND = "open-gemini";
  const OPEN_GEMINI_MESSAGE = "GEMINI_OPEN_NEW_TAB";
  const SAVE_SETTINGS_MESSAGE = "GEMINI_SAVE_SETTINGS";
  const APPLY_MESSAGE = "GEMINI_DEFAULT_MODEL_APPLY";
  const GEMINI_URL = "https://gemini.google.com/app";
  const CONNECTION_TIMEOUT_MS = 30_000;
  const CONNECTION_RETRY_MS = 250;
  let storageWriteQueue = Promise.resolve();
  let latestSaveSequence = 0;

  function delay(durationMs) {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
  }

  async function sendMessageWhenReady(tabId, message) {
    const startedAt = Date.now();
    let lastError = null;

    while (Date.now() - startedAt < CONNECTION_TIMEOUT_MS) {
      try {
        await chrome.tabs.get(tabId);
        return await chrome.tabs.sendMessage(tabId, message);
      } catch (error) {
        lastError = error;
        await delay(CONNECTION_RETRY_MS);
      }
    }

    throw new Error(
      lastError?.message || "Gemini did not finish loading in time."
    );
  }

  function enqueueStorageWrite(settings) {
    const write = storageWriteQueue
      .catch(() => undefined)
      .then(() => chrome.storage.sync.set(settings));
    storageWriteQueue = write;
    return write;
  }

  function captureActiveTab() {
    try {
      return Promise.resolve(chrome.tabs.query({
        active: true,
        currentWindow: true
      })).then(([activeTab]) => ({ activeTab })).catch(() => ({ failed: true }));
    } catch {
      return Promise.resolve({ failed: true });
    }
  }

  async function applySettingsToActiveTab(settings, sequence, activeTabRequest) {
    const activeTabResult = await activeTabRequest;

    if (sequence !== latestSaveSequence) {
      return { ok: true, applied: false, stale: true };
    }
    if (activeTabResult.failed) {
      return { ok: false, error: "Saved, but the active tab was not found." };
    }

    const { activeTab } = activeTabResult;
    if (!activeTab?.id) {
      return { ok: false, error: "Saved, but the active tab was not found." };
    }

    try {
      return await chrome.tabs.sendMessage(activeTab.id, {
        type: APPLY_MESSAGE,
        settings,
        focusComposer: true
      });
    } catch {
      return {
        ok: false,
        error: "Saved. Open or refresh Gemini to apply it.",
        showGeminiLink: true
      };
    }
  }

  async function saveSettingsAndApply(settings, activeTabRequest) {
    const sequence = ++latestSaveSequence;
    const normalizedSettings = core.normalizeSettings(settings);

    try {
      await enqueueStorageWrite(normalizedSettings);
    } catch {
      return { ok: false, saved: false, error: "Could not save the settings." };
    }

    if (sequence !== latestSaveSequence) {
      return { ok: true, saved: true, applied: false, stale: true };
    }

    const result = await applySettingsToActiveTab(
      normalizedSettings, sequence, activeTabRequest
    );
    if (sequence !== latestSaveSequence) {
      return { ok: true, saved: true, applied: false, stale: true };
    }
    return { ...result, saved: true };
  }

  async function openGemini() {
    const tab = await chrome.tabs.create({
      url: GEMINI_URL,
      active: true
    });
    if (typeof tab.id !== "number") {
      throw new Error("Could not open a Gemini tab.");
    }

    await storageWriteQueue.catch(() => undefined);
    const settings = core.normalizeSettings(
      await chrome.storage.sync.get(core.STORAGE_KEYS)
    );
    const result = await sendMessageWhenReady(tab.id, {
      type: APPLY_MESSAGE,
      settings,
      focusComposer: true,
      waitForUi: true,
      initialApplication: true
    });

    if (!result?.ok || !result.applied) {
      throw new Error(
        result?.error || result?.reason || "The Gemini interface is not ready."
      );
    }

    return { ok: true, tabId: tab.id };
  }

  chrome.commands.onCommand.addListener((command) => {
    if (command !== OPEN_GEMINI_COMMAND) {
      return undefined;
    }

    return openGemini().catch((error) => {
      console.error("[Gemini Default Model Selector]", error.message);
      return { ok: false, error: error.message };
    });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === SAVE_SETTINGS_MESSAGE) {
      const activeTabRequest = captureActiveTab();
      saveSettingsAndApply(message.settings, activeTabRequest)
        .then(sendResponse)
        .catch(() => {
          sendResponse({
            ok: false,
            saved: false,
            error: "Could not save or apply the settings."
          });
        });
      return true;
    }

    if (message?.type !== OPEN_GEMINI_MESSAGE) {
      return false;
    }

    openGemini()
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error.message || "Could not open Gemini."
        });
      });
    return true;
  });

  chrome.runtime.onUpdateAvailable.addListener(() => {
    // Apply the downloaded extension update immediately.
    chrome.runtime.reload();
  });
})();
