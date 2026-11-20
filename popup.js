(function initializePopup() {
  "use strict";

  const core = globalThis.GeminiDefaultModelCore;
  const SAVE_SETTINGS_MESSAGE = "GEMINI_SAVE_SETTINGS";
  const OPEN_GEMINI_MESSAGE = "GEMINI_OPEN_NEW_TAB";
  const OPEN_GEMINI_COMMAND = "open-gemini";
  const REVIEW_URL = "https://chromewebstore.google.com/detail/kmklgjnaichjgojddjoecifjhphjgefp/reviews";
  const REVIEW_PROMPT_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
  const reviewPromptDebug = core.REVIEW_PROMPT_DEBUG === 1;
  const reviewPrompt = document.querySelector("#review-prompt");
  const reviewStatus = document.querySelector("#review-status");
  const settingsPanel = document.querySelector("#settings-panel");
  const modelOptions = document.querySelector("#model-options");
  const thinkingSection = document.querySelector("#thinking-section");
  const thinkingSaved = document.querySelector("#thinking-saved");
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
  let settings = core.DEFAULT_SETTINGS;
  let modelCatalog = [];
  let currentGeminiModel = null;
  let catalogRequest = 0;
  let savingReviewChoice = false;
  settingsPanel.inert = true;

  function setStatus(message, kind = "info") {
    status.textContent = message;
    status.dataset.kind = kind;
  }

  async function loadReviewPrompt() {
    if (reviewPromptDebug) {
      reviewPrompt.hidden = false;
      return;
    }

    const nextAtKey = core.REVIEW_PROMPT_NEXT_AT_KEY;
    try {
      const stored = await chrome.storage.local.get([nextAtKey, "reviewPromptDismissed"]);
      const nextAt = stored[nextAtKey];
      reviewPrompt.hidden = Boolean(stored.reviewPromptDismissed)
        || !Number.isFinite(nextAt) || Date.now() < nextAt;
    } catch {
      reviewPrompt.hidden = true;
    }
  }

  reviewPrompt.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-review-action]");
    if (!button || reviewPrompt.hidden || savingReviewChoice) return;

    savingReviewChoice = true;
    const action = button.dataset.reviewAction;
    try {
      if (!reviewPromptDebug) {
        await chrome.storage.local.set(action === "later"
          ? { [core.REVIEW_PROMPT_NEXT_AT_KEY]: Date.now() + REVIEW_PROMPT_SNOOZE_MS }
          : { reviewPromptDismissed: true });
      }
    } catch {
      reviewStatus.textContent = "Could not save your choice. Try again.";
      return;
    } finally {
      savingReviewChoice = false;
    }

    const focusWasInPrompt = reviewPrompt.contains(document.activeElement);
    reviewPrompt.hidden = true;
    if (focusWasInPrompt) document.querySelector("#model-list-title").focus();

    if (action === "rate") {
      try {
        await chrome.tabs.create({ url: REVIEW_URL });
      } catch {
        setStatus("Could not open the Chrome Web Store.", "error");
      }
    }
  });

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
      model: checkedModel?.value ?? settings.model,
      thinkingLevel: thinkingSection.disabled ? settings.thinkingLevel : checkedThinking?.value
    });
  }

  function selectedCatalogModel() {
    return core.resolveCatalogModel(modelCatalog, settings.model, currentGeminiModel);
  }

  function updateThinkingAccess(model = selectedCatalogModel()) {
    thinkingSection.disabled = model === "auto";
    thinkingSaved.hidden = !thinkingSection.disabled;
  }

  function renderModels() {
    const selectedModel = selectedCatalogModel();
    updateThinkingAccess(selectedModel);
    if (!modelCatalog.length) {
      const empty = document.createElement("p");
      empty.className = "model-list-note";
      empty.textContent = "Open Gemini to load your available models.";
      modelOptions.replaceChildren(empty);
      return;
    }

    const activeModelId = document.activeElement?.name === "model"
      ? document.activeElement.value : null;
    const rows = modelCatalog.map(({ id, label, available }, index) => {
      const row = document.createElement("label");
      const input = document.createElement("input");
      const indicator = document.createElement("span");
      const copy = document.createElement("span");
      const title = document.createElement("strong");
      row.className = "model-option";
      input.type = "radio";
      input.name = "model";
      input.id = `model-option-${index}`;
      input.value = id;
      input.checked = id === selectedModel;
      input.disabled = !available;
      row.htmlFor = input.id;
      indicator.className = "radio-indicator";
      indicator.setAttribute("aria-hidden", "true");
      copy.className = "model-copy";
      title.textContent = label;
      copy.append(title);
      if (!available) {
        const note = document.createElement("span");
        note.className = "model-list-note";
        note.textContent = "Unavailable";
        copy.append(note);
      }
      row.append(input, indicator, copy);
      return row;
    });
    modelOptions.replaceChildren(...rows);
    if (activeModelId) {
      modelOptions.querySelector(`input[value="${activeModelId}"]:enabled`)?.focus();
    }
  }

  function loadModels(cached) {
    const request = ++catalogRequest;
    function showCatalog(result) {
      if (request !== catalogRequest) return;
      const models = core.readModelCatalog(result?.catalog);
      modelCatalog = models.length ? models : core.readModelCatalog(cached);
      currentGeminiModel = models.length ? result.currentModel : null;
      renderModels();
    }

    // Доступность зависит от аккаунта Gemini. На открытой вкладке
    // используем её список, а общий кэш нужен для остальных страниц.
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab] = []) => {
      if (chrome.runtime.lastError || !tab?.id) {
        showCatalog();
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: core.READ_MODEL_CATALOG_MESSAGE }, (result) => {
        showCatalog(chrome.runtime.lastError ? undefined : result);
      });
    });
  }

  function writeForm(settings) {
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
    settings = readForm();
    updateThinkingAccess();
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

  let catalogChangedDuringLoad = false;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[core.MODEL_CATALOG_KEY]) return;
    catalogChangedDuringLoad = true;
    loadModels(changes[core.MODEL_CATALOG_KEY].newValue);
  });
  chrome.storage.local.get(core.MODEL_CATALOG_KEY, (stored) => {
    if (chrome.runtime.lastError || catalogChangedDuringLoad) return;
    loadModels(stored[core.MODEL_CATALOG_KEY]);
  });

  chrome.storage.sync.get(core.STORAGE_KEYS, (storedSettings) => {
    if (settingsChanged) {
      settingsPanel.inert = false;
      return;
    }
    settings = core.normalizeSettings(storedSettings);
    renderModels();
    writeForm(settings);
    settingsPanel.inert = false;
    setStatus("Changes save automatically");
  });

  checkGeminiSiteAccess();
  updateShortcutLabel();
  loadReviewPrompt();
})();
