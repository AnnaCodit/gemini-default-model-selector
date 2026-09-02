(function initializeBackground() {
  "use strict";

  const OPEN_GEMINI_COMMAND = "open-gemini";
  const OPEN_GEMINI_MESSAGE = "GEMINI_OPEN_NEW_TAB";
  const APPLY_MESSAGE = "GEMINI_DEFAULT_MODEL_APPLY";
  const GEMINI_URL = "https://gemini.google.com/app";
  const CONNECTION_TIMEOUT_MS = 30_000;
  const CONNECTION_RETRY_MS = 250;
  const DEFAULT_SETTINGS = {
    model: "flash-3.8",
    extendedThinking: true
  };

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

  async function openGemini() {
    const tab = await chrome.tabs.create({
      url: GEMINI_URL,
      active: true
    });
    if (typeof tab.id !== "number") {
      throw new Error("Could not open a Gemini tab.");
    }

    const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    const result = await sendMessageWhenReady(tab.id, {
      type: APPLY_MESSAGE,
      settings,
      focusComposer: true,
      waitForUi: true
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
})();
