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
  const REVIEW_PROMPT_FIRST_DELAY_MS = 14 * 24 * 60 * 60 * 1000;
  let storageWriteQueue = Promise.resolve();
  let latestSaveSequence = 0;

  function delay(durationMs) {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
  }

  async function sendMessageWhenReady(tabId, createMessage) {
    const startedAt = Date.now();
    let lastError = null;

    while (Date.now() - startedAt < CONNECTION_TIMEOUT_MS) {
      try {
        await chrome.tabs.get(tabId);
      } catch (error) {
        lastError = error;
        await delay(CONNECTION_RETRY_MS);
        continue;
      }

      const message = await createMessage();
      try {
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

  async function readLatestSettings() {
    while (true) {
      const sequence = latestSaveSequence;
      const pendingWrite = storageWriteQueue;
      await pendingWrite.catch(() => undefined);
      if (sequence !== latestSaveSequence || pendingWrite !== storageWriteQueue) {
        continue;
      }

      const storedSettings = await chrome.storage.sync.get(core.STORAGE_KEYS);
      if (sequence !== latestSaveSequence || pendingWrite !== storageWriteQueue) {
        continue;
      }
      return core.normalizeSettings(storedSettings);
    }
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
    const { activeTab } = activeTabResult;
    if (activeTabResult.failed || !activeTab?.id) {
      return { ok: false, messageKey: "popup_saved_no_active_tab" };
    }

    try {
      return await chrome.tabs.sendMessage(activeTab.id, {
        type: APPLY_MESSAGE,
        settings,
        focusComposer: true
      });
    } catch {
      return { ok: false, showGeminiLink: true };
    }
  }

  async function saveSettingsAndApply(settings, activeTabRequest) {
    const sequence = ++latestSaveSequence;
    const normalizedSettings = core.normalizeSettings(settings);

    try {
      await enqueueStorageWrite(normalizedSettings);
    } catch {
      return { ok: false, saved: false, messageKey: "popup_save_failed" };
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

    let result;
    try {
      result = await sendMessageWhenReady(tab.id, async () => ({
        type: APPLY_MESSAGE,
        settings: await readLatestSettings(),
        focusComposer: true,
        waitForUi: true,
        initialApplication: true
      }));
    } catch (error) {
      console.error("[Gemini Default Model Selector]", error.message);
      return { ok: false, messageKey: "popup_gemini_not_ready" };
    }

    if (!result?.ok || !result.applied) {
      return {
        ok: false,
        messageKey: result?.messageKey || "popup_gemini_not_ready",
        substitution: result?.substitution
      };
    }

    return { ok: true, tabId: tab.id };
  }

  chrome.commands.onCommand.addListener((command) => {
    if (command !== OPEN_GEMINI_COMMAND) {
      return undefined;
    }

    return (async () => {
      try {
        const result = await openGemini();
        if (!result.ok) console.error("[Gemini Default Model Selector]", result.messageKey);
        return result;
      } catch (error) {
        console.error("[Gemini Default Model Selector]", error.message);
        return { ok: false, messageKey: "popup_open_gemini_failed" };
      }
    })();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const isSave = message?.type === SAVE_SETTINGS_MESSAGE;
    if (!isSave && message?.type !== OPEN_GEMINI_MESSAGE) {
      return false;
    }

    (async () => {
      let result;
      try {
        result = isSave
          ? await saveSettingsAndApply(message.settings, captureActiveTab())
          : await openGemini();
      } catch {
        result = isSave
          ? { ok: false, saved: false, messageKey: "popup_save_or_apply_failed" }
          : { ok: false, messageKey: "popup_open_gemini_failed" };
      }
      sendResponse(result);
    })();
    return true;
  });

  chrome.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason !== "install" && reason !== "update") return;

    const nextAtKey = core.REVIEW_PROMPT_NEXT_AT_KEY;
    const firstPromptAt = Date.now() + REVIEW_PROMPT_FIRST_DELAY_MS;
    try {
      const stored = await chrome.storage.local.get(nextAtKey);
      if (stored[nextAtKey] === undefined) {
        await chrome.storage.local.set({ [nextAtKey]: firstPromptAt });
      }
    } catch {
      console.error("[Gemini Default Model Selector] Could not schedule the review prompt.");
    }
  });

  chrome.runtime.onUpdateAvailable.addListener(() => {
    // Apply the downloaded extension update immediately.
    chrome.runtime.reload();
  });
})();
