(function initializePopup() {
  "use strict";

  const core = globalThis.GeminiDefaultModelCore;
  const APPLY_MESSAGE = "GEMINI_DEFAULT_MODEL_APPLY";
  const settingsPanel = document.querySelector("#settings-panel");
  const extendedInput = document.querySelector("#extended-thinking");
  const status = document.querySelector("#status");
  let saveTimer = null;

  function setStatus(message, kind = "info") {
    status.textContent = message;
    status.dataset.kind = kind;
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
        error: "Saved. Open or refresh gemini.google.com to apply it."
      };
    }
  }

  async function saveAndApply() {
    const settings = readForm();
    await saveSettings(settings);
    const result = await applyToCurrentTab(settings, true);

    if (!result?.ok) {
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

  settingsPanel.addEventListener("change", () => {
    clearTimeout(saveTimer);
    setStatus("Saving…");
    saveTimer = setTimeout(() => {
      saveAndApply().catch(() => {
        setStatus("Could not save the settings.", "error");
      });
    }, 120);
  });

  chrome.storage.sync.get(core.DEFAULT_SETTINGS, (storedSettings) => {
    const settings = core.normalizeSettings(storedSettings);
    writeForm(settings);
    setStatus("Changes save automatically");
  });
})();
