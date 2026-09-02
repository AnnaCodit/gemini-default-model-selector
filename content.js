(function initializeContentScript() {
  "use strict";

  const core = globalThis.GeminiDefaultModelCore;
  const APPLY_MESSAGE = "GEMINI_DEFAULT_MODEL_APPLY";
  const RETRY_DELAY_MS = 150;
  const UI_TIMEOUT_MS = 3500;
  const COLD_START_UI_TIMEOUT_MS = 30_000;
  const INTERACTION_SETTLE_MS = 250;
  const STATE_STABLE_MS = 200;
  const MAX_INTERACTION_ATTEMPTS = 2;

  let currentSettings = core.DEFAULT_SETTINGS;
  let applyQueue = Promise.resolve();
  let scheduledTimer = null;
  let initialApplicationComplete = false;
  let initialApplicationInProgress = false;
  let initialObserver = null;

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function findModePicker() {
    const candidates = document.querySelectorAll(
      'button[aria-haspopup="true"], button.input-area-switch'
    );

    return (
      Array.from(candidates).find((button) => {
        if (!isVisible(button)) {
          return false;
        }

        const label = button.getAttribute("aria-label") || "";
        const pickerState = readPickerState(button);
        return (
          label.toLocaleLowerCase("en-US").includes("mode picker") ||
          button.classList.contains("input-area-switch") ||
          pickerState.model !== null
        );
      }) || null
    );
  }

  function readPickerState(picker) {
    return core.resolvePickerState(
      `${picker.getAttribute("aria-label") || ""} ${picker.textContent || ""}`,
      Boolean(picker.querySelector(".picker-secondary-text"))
    );
  }

  function findPromptEditor() {
    const selectors = [
      '[role="textbox"][contenteditable="true"][aria-label*="prompt" i]',
      '[role="textbox"][contenteditable="true"].ql-editor',
      'textarea[aria-label*="prompt" i]'
    ];

    for (const selector of selectors) {
      const editor = Array.from(document.querySelectorAll(selector)).find(isVisible);
      if (editor) {
        return editor;
      }
    }

    return null;
  }

  function captureEditorSelection() {
    const editor = findPromptEditor();
    const selection = document.getSelection();
    const activeElement = document.activeElement;

    if (
      editor &&
      selection &&
      selection.rangeCount > 0 &&
      (activeElement === editor || editor.contains(activeElement)) &&
      editor.contains(selection.anchorNode)
    ) {
      return { editor, range: selection.getRangeAt(0).cloneRange() };
    }

    return { editor, range: null };
  }

  function placeCaretAtEnd(editor) {
    if (!(editor instanceof HTMLElement) || !editor.isContentEditable) {
      return;
    }

    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function restoreEditorFocus(snapshot, timeoutMs = UI_TIMEOUT_MS) {
    const editor = await waitFor(findPromptEditor, timeoutMs);
    if (!editor) {
      return false;
    }

    editor.focus({ preventScroll: true });

    if (editor instanceof HTMLTextAreaElement) {
      const caretPosition = editor.value.length;
      editor.setSelectionRange(caretPosition, caretPosition);
      return true;
    }

    const selection = document.getSelection();
    if (
      snapshot?.range &&
      snapshot.editor === editor &&
      snapshot.editor.isConnected &&
      selection
    ) {
      try {
        selection.removeAllRanges();
        selection.addRange(snapshot.range);
        return true;
      } catch {
        // Gemini мог перерисовать редактор. В этом случае ставим каретку в конец.
      }
    }

    placeCaretAtEnd(editor);
    return true;
  }

  function getVisibleMenuItems() {
    return Array.from(document.querySelectorAll('[role="menuitem"]')).filter(
      isVisible
    );
  }

  function delay(durationMs) {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
  }

  async function waitFor(getValue, timeoutMs) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const value = getValue();
      if (value) {
        return value;
      }
      await delay(50);
    }

    return null;
  }

  async function waitForStablePickerState(matchesExpectedState) {
    const startedAt = Date.now();
    let matchingSince = null;

    while (Date.now() - startedAt < UI_TIMEOUT_MS) {
      const picker = findModePicker();
      const state = picker ? readPickerState(picker) : null;

      if (state && matchesExpectedState(state)) {
        matchingSince ??= Date.now();
        if (Date.now() - matchingSince >= STATE_STABLE_MS) {
          return state;
        }
      } else {
        matchingSince = null;
      }

      await delay(50);
    }

    return null;
  }

  async function openModeMenu() {
    const picker = findModePicker();
    if (!picker) {
      return null;
    }

    const currentItems = getVisibleMenuItems();
    if (picker.getAttribute("aria-expanded") === "true" && currentItems.length) {
      return currentItems;
    }

    picker.click();
    return waitFor(() => {
      const currentPicker = findModePicker();
      const items = getVisibleMenuItems();
      return currentPicker?.getAttribute("aria-expanded") === "true" &&
        items.length
        ? items
        : null;
    }, UI_TIMEOUT_MS);
  }

  function findMenuItem(items, prefix) {
    const expected = core.normalizeText(prefix).toLocaleLowerCase("en-US");

    return (
      items.find((item) =>
        core
          .normalizeText(item.textContent)
          .toLocaleLowerCase("en-US")
          .startsWith(expected)
      ) || null
    );
  }

  function findExtendedThinkingMenuItem(items) {
    const index = core.findExtendedOptionIndex(
      items.map((item) => ({
        text: item.textContent,
        followsSeparator:
          item.previousElementSibling?.getAttribute("role") === "separator"
      }))
    );
    return index >= 0 ? items[index] : null;
  }

  async function selectModel(modelId) {
    const model = core.getModel(modelId);
    if (!model) {
      throw new Error(`Unknown model: ${modelId}`);
    }

    for (let attempt = 0; attempt < MAX_INTERACTION_ATTEMPTS; attempt += 1) {
      const pickerBefore = findModePicker();
      const currentModel = pickerBefore
        ? readPickerState(pickerBefore).model
        : null;
      if (currentModel === modelId) {
        return { modelId, changed: false };
      }

      const items = await openModeMenu();
      if (!items) {
        await delay(INTERACTION_SETTLE_MS);
        continue;
      }

      let menuItem = findMenuItem(items, model.menuPrefix);
      let effectiveModel = model;

      if (!menuItem && model.fallbackId) {
        const fallback = core.getModel(model.fallbackId);
        if (fallback) {
          const fallbackItem = findMenuItem(items, fallback.menuPrefix);
          if (fallbackItem) {
            menuItem = fallbackItem;
            effectiveModel = fallback;
          }
        }
      }

      if (!menuItem) {
        throw new Error(`Could not find the ${model.label} model option.`);
      }

      if (currentModel === effectiveModel.id) {
        const picker = findModePicker();
        if (picker?.getAttribute("aria-expanded") === "true") {
          picker.click();
          await delay(INTERACTION_SETTLE_MS);
        }
        return { modelId: effectiveModel.id, changed: false };
      }

      menuItem.click();

      const applied = await waitForStablePickerState(
        (state) => state.model === effectiveModel.id
      );

      if (applied) {
        await delay(INTERACTION_SETTLE_MS);
        return { modelId: effectiveModel.id, changed: true };
      }

      await delay(INTERACTION_SETTLE_MS);
    }

    throw new Error(`Gemini did not confirm the ${model.label} model.`);
  }

  async function setExtendedThinking(enabled) {
    let didClick = false;

    for (let attempt = 0; attempt < MAX_INTERACTION_ATTEMPTS; attempt += 1) {
      const pickerBefore = findModePicker();
      if (
        pickerBefore &&
        readPickerState(pickerBefore).extendedThinking === enabled
      ) {
        return didClick;
      }

      const items = await openModeMenu();
      if (!items) {
        await delay(INTERACTION_SETTLE_MS);
        continue;
      }

      const menuItem = findExtendedThinkingMenuItem(items);
      if (!menuItem) {
        await delay(INTERACTION_SETTLE_MS);
        continue;
      }

      menuItem.click();
      didClick = true;

      const applied = await waitForStablePickerState(
        (state) => state.extendedThinking === enabled
      );

      if (applied) {
        await delay(INTERACTION_SETTLE_MS);
        return true;
      }

      await delay(INTERACTION_SETTLE_MS);
    }

    throw new Error("Gemini did not confirm the Extended thinking setting.");
  }

  async function applySettings(options = {}) {
    const targetSettings = currentSettings;
    const picker = await waitFor(
      findModePicker,
      options.timeoutMs || UI_TIMEOUT_MS
    );
    if (!picker) {
      return { applied: false, reason: "The Gemini interface is not ready yet." };
    }

    const selectionSnapshot = captureEditorSelection();
    let changed = false;
    let effectiveModelId = targetSettings.model;

    try {
      const initialState = readPickerState(picker);
      if (initialState.model !== targetSettings.model) {
        const selectionResult = await selectModel(targetSettings.model);
        if (selectionResult?.modelId) {
          effectiveModelId = selectionResult.modelId;
        }
        if (selectionResult?.changed) {
          changed = true;
        }
      }

      const extendedChanged = await setExtendedThinking(
        targetSettings.extendedThinking
      );
      if (extendedChanged) {
        changed = true;
      }

      let finalState = await waitForStablePickerState(
        (state) =>
          state.model === effectiveModelId &&
          state.extendedThinking === targetSettings.extendedThinking
      );

      if (!finalState) {
        const pickerAfter = findModePicker();
        const stateAfter = pickerAfter ? readPickerState(pickerAfter) : null;

        if (!stateAfter || stateAfter.model !== effectiveModelId) {
          const retryResult = await selectModel(targetSettings.model);
          if (retryResult?.modelId) {
            effectiveModelId = retryResult.modelId;
          }
          if (retryResult?.changed) {
            changed = true;
          }
        }

        const pickerAfterModelRetry = findModePicker();
        const stateAfterModelRetry = pickerAfterModelRetry
          ? readPickerState(pickerAfterModelRetry)
          : null;
        if (
          !stateAfterModelRetry ||
          stateAfterModelRetry.extendedThinking !==
            targetSettings.extendedThinking
        ) {
          const extendedRetried = await setExtendedThinking(
            targetSettings.extendedThinking
          );
          if (extendedRetried) {
            changed = true;
          }
        }

        finalState = await waitForStablePickerState(
          (state) =>
            state.model === effectiveModelId &&
            state.extendedThinking === targetSettings.extendedThinking
        );
      }

      if (!finalState) {
        throw new Error("Gemini did not confirm the final model settings.");
      }

      if (changed || options.focusComposer) {
        await restoreEditorFocus(
          selectionSnapshot,
          options.timeoutMs || UI_TIMEOUT_MS
        );
      }

      return { applied: true, changed };
    } catch (error) {
      await restoreEditorFocus(
        selectionSnapshot,
        options.timeoutMs || UI_TIMEOUT_MS
      );
      throw error;
    }
  }

  function enqueueApply(options = {}) {
    applyQueue = applyQueue
      .catch(() => undefined)
      .then(() => applySettings(options));
    return applyQueue;
  }

  function stopInitialApplication() {
    initialApplicationComplete = true;
    clearTimeout(scheduledTimer);
    scheduledTimer = null;
    initialObserver?.disconnect();
    initialObserver = null;
  }

  function completeInitialApplication(result) {
    if (result?.applied) {
      stopInitialApplication();
    }
  }

  function scheduleInitialApply() {
    if (
      initialApplicationComplete ||
      initialApplicationInProgress ||
      scheduledTimer !== null
    ) {
      return;
    }

    scheduledTimer = setTimeout(() => {
      scheduledTimer = null;
      initialApplicationInProgress = true;
      enqueueApply({ focusComposer: false })
        .then(completeInitialApplication)
        .catch((error) => {
          // Внутри одного применения уже есть повтор клика. Не запускаем
          // бесконечный цикл, который будет открывать меню снова и снова.
          stopInitialApplication();
          console.debug("[Gemini Default Model Selector]", error.message);
        })
        .finally(() => {
          initialApplicationInProgress = false;
        });
    }, RETRY_DELAY_MS);
  }

  function watchForInitialPicker() {
    initialObserver = new MutationObserver(() => {
      if (initialApplicationComplete || !findModePicker()) {
        return;
      }

      scheduleInitialApply();
    });

    initialObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["aria-label"],
      childList: true,
      subtree: true
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") {
      return;
    }

    const nextSettings = {
      ...currentSettings,
      ...(changes.model ? { model: changes.model.newValue } : {}),
      ...(changes.extendedThinking
        ? { extendedThinking: changes.extendedThinking.newValue }
        : {})
    };

    currentSettings = core.normalizeSettings(nextSettings);
    // Синхронизация меняет значение по умолчанию, но не должна повторно
    // переключать уже открытую вкладку. Нужная вкладка получает одну явную
    // команду, а остальные сохраняют ручной выбор пользователя.
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === APPLY_MESSAGE) {
      currentSettings = core.normalizeSettings(message.settings);
      enqueueApply({
        focusComposer: message.focusComposer !== false,
        timeoutMs: message.waitForUi ? COLD_START_UI_TIMEOUT_MS : undefined
      })
        .then((result) => {
          completeInitialApplication(result);
          sendResponse({ ok: true, ...result });
        })
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    return false;
  });

  chrome.storage.sync.get(core.DEFAULT_SETTINGS, (storedSettings) => {
    currentSettings = core.normalizeSettings(storedSettings);
    watchForInitialPicker();
    scheduleInitialApply();
  });
})();
