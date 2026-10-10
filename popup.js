(function initializePopup() {
  "use strict";

  const core = globalThis.GeminiDefaultModelCore;
  const APPLY_MESSAGE = "GEMINI_DEFAULT_MODEL_APPLY";
  const OPEN_GEMINI_MESSAGE = "GEMINI_OPEN_NEW_TAB";
  const OPEN_GEMINI_COMMAND = "open-gemini";
  const settingsPanel = document.querySelector("#settings-panel");
  const openGeminiButton = document.querySelector("#open-gemini");
  const shortcutLabel = document.querySelector("#open-gemini-shortcut");
  const shortcutChangeButton = document.querySelector(
    "#open-gemini-shortcut-change"
  );
  const status = document.querySelector("#status");
  let saveTimer = null;

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
    const checkedThinking = settingsPanel.querySelector(
      'input[name="thinkingLevel"]:checked'
    );
    return core.normalizeSettings({
      model: checkedModel?.value,
      thinkingLevel: checkedThinking?.value
    });
  }

  function writeForm(settings) {
    const modelInput = settingsPanel.querySelector(
      `input[name="model"][value="${settings.model}"]`
    );
    if (modelInput) {
      modelInput.checked = true;
    }
    const thinkingInput = settingsPanel.querySelector(
      `input[name="thinkingLevel"][value="${settings.thinkingLevel}"]`
    );
    if (thinkingInput) {
      thinkingInput.checked = true;
    }
  }

  async function saveSettings(settings) {
    await chrome.storage.sync.set(settings);
  }

  async function updateShortcutLabel() {
    try {
      const commands = await chrome.commands.getAll();
      const openCommand = commands.find(
        (command) => command.name === OPEN_GEMINI_COMMAND
      );
      shortcutLabel.textContent = openCommand?.shortcut
        ? `(${openCommand.shortcut})`
        : "(hotkey not set)";
    } catch {
      shortcutLabel.textContent = "(hotkey unavailable)";
    }
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

  settingsPanel.addEventListener("change", () => {
    clearTimeout(saveTimer);
    setStatus("Saving…");
    saveTimer = setTimeout(() => {
      saveAndApply().catch(() => {
        setStatus("Could not save the settings.", "error");
      });
    }, 120);
  });

  openGeminiButton.addEventListener("click", async () => {
    setStatus("Opening Gemini…");
    try {
      const result = await chrome.runtime.sendMessage({
        type: OPEN_GEMINI_MESSAGE
      });
      if (!result?.ok) {
        throw new Error(result?.error || "Could not open Gemini.");
      }
    } catch (error) {
      setStatus(error.message || "Could not open Gemini.", "error");
    }
  });

  shortcutChangeButton.addEventListener("click", async () => {
    try {
      await chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
    } catch {
      setStatus(
        "Open chrome://extensions/shortcuts to change the hotkey.",
        "info"
      );
    }
  });

  chrome.storage.sync.get(core.STORAGE_KEYS, (storedSettings) => {
    const settings = core.normalizeSettings(storedSettings);
    writeForm(settings);
    setStatus("Changes save automatically");
  });

  updateShortcutLabel();
})();
