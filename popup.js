(function initializePopup() {
  "use strict";

  const core = globalThis.GeminiDefaultModelCore;
  const APPLY_MESSAGE = "GEMINI_DEFAULT_MODEL_APPLY";
  const RUN_PROMPT_MESSAGE = "GEMINI_FAST_PROMPT_RUN";
  const settingsPanel = document.querySelector("#settings-panel");
  const extendedInput = document.querySelector("#extended-thinking");
  const promptInput = document.querySelector("#fast-prompt-input");
  const promptSendButton = document.querySelector("#fast-prompt-send");
  const status = document.querySelector("#status");
  let saveTimer = null;
  let promptInFlight = false;

  function setStatus(message, kind = "info") {
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function setGeminiLinkStatus() {
    const link = document.createElement("a");
    link.href = "https://gemini.google.com/";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Gemini";

    status.replaceChildren(
      document.createTextNode("Saved. Open or refresh "),
      link,
      document.createTextNode(" to apply it.")
    );
    status.dataset.kind = "success";
  }

  function readForm() {
    const checkedModel = settingsPanel.querySelector(
      'input[name="model"]:checked'
    );
    return core.normalizeSettings({
      model: checkedModel?.value,
      extendedThinking: extendedInput.checked
    });
  }

  function writeForm(settings) {
    const modelInput = settingsPanel.querySelector(
      `input[name="model"][value="${settings.model}"]`
    );
    if (modelInput) {
      modelInput.checked = true;
    }
    extendedInput.checked = settings.extendedThinking;
  }

  async function saveSettings(settings) {
    await chrome.storage.sync.set(settings);
  }

  async function applyToCurrentTab(settings, focusComposer) {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (!activeTab?.id) {
      return { ok: false, error: "Saved, but the active tab was not found." };
    }

    try {
      return await chrome.tabs.sendMessage(activeTab.id, {
        type: APPLY_MESSAGE,
        settings,
        focusComposer
      });
    } catch {
      return {
        ok: false,
        error: "Saved. Open or refresh Gemini to apply it.",
        showGeminiLink: true
      };
    }
  }

  async function saveAndApply() {
    const settings = readForm();
    await saveSettings(settings);
    const result = await applyToCurrentTab(settings, true);

    if (!result?.ok) {
      if (result?.showGeminiLink) {
        setGeminiLinkStatus();
        return false;
      }
      setStatus(result?.error || "Saved, but not applied yet.", "error");
      return false;
    }

    if (!result.applied) {
      setStatus("Saved. Gemini is still loading.", "error");
      return false;
    }

    setStatus("Saved", "success");
    return true;
  }

  function setPromptBusy(isBusy) {
    promptInFlight = isBusy;
    promptInput.disabled = isBusy;
    promptSendButton.disabled = isBusy;
    promptSendButton.textContent = isBusy ? "Sending…" : "Send";
  }

  async function runFastPrompt() {
    if (promptInFlight) {
      return;
    }

    const prompt = promptInput.value.trim();
    if (!prompt) {
      setStatus("Enter a prompt first.", "error");
      promptInput.focus();
      return;
    }

    clearTimeout(saveTimer);
    const settings = readForm();
    setPromptBusy(true);
    setStatus("Opening Gemini and sending…");

    try {
      await saveSettings(settings);
      const result = await chrome.runtime.sendMessage({
        type: RUN_PROMPT_MESSAGE,
        prompt,
        settings
      });

      if (!result?.ok) {
        throw new Error(result?.error || "Could not send the prompt.");
      }

      promptInput.value = "";
      setStatus("Sent to Gemini", "success");
    } catch (error) {
      setStatus(error.message || "Could not send the prompt.", "error");
    } finally {
      setPromptBusy(false);
      promptInput.focus();
    }
  }

  settingsPanel.addEventListener("change", () => {
    clearTimeout(saveTimer);
    setStatus("Saving…");
    saveTimer = setTimeout(() => {
      saveAndApply().catch(() => {
        setStatus("Could not save the settings.", "error");
      });
    }, 120);
  });

  promptSendButton.addEventListener("click", () => {
    runFastPrompt();
  });

  promptInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
      return;
    }

    event.preventDefault();
    runFastPrompt();
  });

  chrome.storage.sync.get(core.DEFAULT_SETTINGS, (storedSettings) => {
    const settings = core.normalizeSettings(storedSettings);
    writeForm(settings);
    setStatus("Changes save automatically");
  });

  requestAnimationFrame(() => {
    promptInput.focus();
  });
})();
