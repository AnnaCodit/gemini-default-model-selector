(function initializePopup() {
  "use strict";

  const core = globalThis.GeminiDefaultModelCore;
  const SAVE_SETTINGS_MESSAGE = "GEMINI_SAVE_SETTINGS";
  const OPEN_GEMINI_MESSAGE = "GEMINI_OPEN_NEW_TAB";
  const OPEN_GEMINI_COMMAND = "open-gemini";
  const settingsPanel = document.querySelector("#settings-panel");
  const openGeminiButton = document.querySelector("#open-gemini");
  const shortcutLabel = document.querySelector("#open-gemini-shortcut");
  const shortcutChangeButton = document.querySelector(
    "#open-gemini-shortcut-change"
  );
  const siteAccessWarning = document.querySelector("#site-access-warning");
  const siteAccessSettingsButton = document.querySelector("#site-access-settings");
  const status = document.querySelector("#status");
  const GEMINI_ORIGIN = "https://gemini.google.com/*";
  let settingsChangeSequence = 0;
  let settingsChanged = false;
  settingsPanel.inert = true;

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

  async function checkGeminiSiteAccess() {
    try {
      const hasGeminiAccess = await chrome.permissions.contains({
        origins: [GEMINI_ORIGIN]
      });
      siteAccessWarning.hidden = hasGeminiAccess;
    } catch {
      siteAccessWarning.hidden = true;
    }
  }

  function showSaveResult(result, sequence) {
    if (result?.stale || sequence !== settingsChangeSequence) {
      return;
    }
    if (!result?.ok) {
      if (result?.showGeminiLink) {
        setGeminiLinkStatus();
        return;
      }
      setStatus(result?.error || "Saved, but not applied yet.", "error");
      return;
    }

    if (!result.applied) {
      setStatus("Saved. Gemini is still loading.", "error");
      return;
    }

    setStatus("Saved", "success");
  }

  settingsPanel.addEventListener("change", () => {
    const settings = readForm();
    const sequence = ++settingsChangeSequence;
    settingsChanged = true;
    setStatus("Saving…");
    try {
      Promise.resolve(chrome.runtime.sendMessage({
        type: SAVE_SETTINGS_MESSAGE,
        settings,
        sequence
      })).then((result) => showSaveResult(result, sequence)).catch(() => {
        if (sequence === settingsChangeSequence) {
          setStatus("Could not save the settings. Try reopening the extension.", "error");
        }
      });
    } catch {
      if (sequence === settingsChangeSequence) {
        setStatus("Could not save the settings. Try reopening the extension.", "error");
      }
    }
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

  siteAccessSettingsButton.addEventListener("click", async () => {
    try {
      await chrome.tabs.create({
        url: `chrome://extensions/?id=${chrome.runtime.id}`
      });
    } catch {
      setStatus("Could not open extension site access settings.", "error");
    }
  });

  chrome.storage.sync.get(core.STORAGE_KEYS, (storedSettings) => {
    if (settingsChanged) {
      settingsPanel.inert = false;
      return;
    }
    const settings = core.normalizeSettings(storedSettings);
    writeForm(settings);
    settingsPanel.inert = false;
    setStatus("Changes save automatically");
  });

  checkGeminiSiteAccess();
  updateShortcutLabel();
})();
