(function initializeBackground() {
  "use strict";

  const RUN_PROMPT_MESSAGE = "GEMINI_FAST_PROMPT_RUN";
  const SUBMIT_PROMPT_MESSAGE = "GEMINI_FAST_PROMPT_SUBMIT";
  const GEMINI_URL = "https://gemini.google.com/app";
  const CONNECTION_TIMEOUT_MS = 30_000;
  const CONNECTION_RETRY_MS = 250;

  function delay(durationMs) {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
  }

  async function createGeminiTab() {
    return chrome.tabs.create({
      url: GEMINI_URL,
      active: true
    });
  }

  async function sendPromptWhenReady(
    tabId,
    message,
    timeoutMs = CONNECTION_TIMEOUT_MS
  ) {
    const startedAt = Date.now();
    let lastError = null;

    while (Date.now() - startedAt < timeoutMs) {
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

  async function runFastPrompt(message) {
    const prompt = typeof message.prompt === "string"
      ? message.prompt.trim()
      : "";

    if (!prompt) {
      throw new Error("The prompt is empty.");
    }

    const tab = await createGeminiTab();
    if (typeof tab.id !== "number") {
      throw new Error("Could not open a Gemini tab.");
    }

    const submitMessage = {
      type: SUBMIT_PROMPT_MESSAGE,
      prompt,
      settings: message.settings
    };
    const result = await sendPromptWhenReady(tab.id, submitMessage);

    if (!result?.ok) {
      throw new Error(result?.error || "Gemini did not accept the prompt.");
    }

    return { ok: true, tabId: tab.id };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== RUN_PROMPT_MESSAGE) {
      return false;
    }

    runFastPrompt(message)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error.message || "Could not send the prompt."
        });
      });
    return true;
  });
})();
