(function initializeContentScript() {
  "use strict";

  const core = globalThis.GeminiDefaultModelCore;
  const APPLY_MESSAGE = "GEMINI_DEFAULT_MODEL_APPLY";
  const RETRY_DELAY_MS = 150;
  const UI_TIMEOUT_MS = 3500;
  const COLD_START_UI_TIMEOUT_MS = 30_000;
  const STATE_STABLE_MS = 200;
  const STATE_POLL_MS = 50;
  const MAX_INTERACTION_ATTEMPTS = 2;
  const MENU_ITEM_SELECTOR =
    '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="radio"], input[type="radio"]';

  let currentSettings = core.DEFAULT_SETTINGS;
  let rawSettings = {};
  let applyQueue = Promise.resolve();
  let scheduledTimer = null;
  let initialApplicationComplete = false;
  let initialApplicationInProgress = false;
  let initialApplicationRequest = null;
  let initialApplicationSettings = null;
  let initialObserver = null;

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" &&
      element.getClientRects().length > 0;
  }

  function findModePicker() {
    const candidates = document.querySelectorAll(
      'button[aria-haspopup="true"], button[aria-haspopup="menu"], button.input-area-switch'
    );

    const visible = Array.from(candidates).filter(isVisible);
    return visible.find((button) => button.classList.contains("input-area-switch")) ||
      visible.find((button) =>
        (button.getAttribute("aria-label") || "").toLocaleLowerCase("en-US").includes("mode picker")
      ) || visible.find((button) => readPickerState(button).model !== null) || null;
  }

  function isControlEnabled(element) {
    return Boolean(element && !element.disabled &&
      element.getAttribute("aria-disabled") !== "true" &&
      element.getAttribute("aria-busy") !== "true");
  }

  function readPickerState(picker) {
    return core.inferPickerState(
      `${picker.getAttribute("aria-label") || ""} ${picker.textContent || ""}`
    );
  }

  function findPromptEditor() {
    const selectors = [
      '[role="textbox"][contenteditable="true"][aria-label*="prompt" i]',
      '[role="textbox"][contenteditable="true"].ql-editor',
      'textarea[aria-label*="prompt" i]'
    ];

    for (const selector of selectors) {
      const editor = Array.from(document.querySelectorAll(selector)).find((element) =>
        isVisible(element) && isControlEnabled(element) && !element.readOnly
      );
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
    const wasFocused = Boolean(
      editor && (activeElement === editor || editor.contains(activeElement))
    );

    if (
      editor &&
      selection &&
      selection.rangeCount > 0 &&
      (activeElement === editor || editor.contains(activeElement)) &&
      editor.contains(selection.anchorNode)
    ) {
      return { editor, range: selection.getRangeAt(0).cloneRange(), wasFocused };
    }

    return { editor, range: null, wasFocused };
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

  function findModeMenu(picker = findModePicker()) {
    if (!picker) {
      return null;
    }

    let menu = (picker.getAttribute("aria-controls") || "")
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .find((element) => element && isVisible(element));
    if (!menu) {
      const menus = Array.from(document.querySelectorAll(
        '[data-test-id="gem-mode-menu"], [role="menu"]'
      )).filter(isVisible).filter((candidate) =>
        candidate.getAttribute("data-test-id") === "gem-mode-menu" ||
        Array.from(candidate.querySelectorAll(MENU_ITEM_SELECTOR)).some((item) =>
          item.hasAttribute("data-mode-id") ||
          core.MODEL_OPTIONS.some((model) => findMenuItem([item], model.menuPrefix))
        )
      );
      menu = menus.length === 1 ? menus[0] : null;
    }
    return menu;
  }

  function getVisibleMenuItems() {
    const picker = findModePicker();
    if (picker?.getAttribute("aria-expanded") !== "true") {
      return [];
    }
    const menu = findModeMenu(picker);
    if (!menu) {
      return [];
    }

    const items = Array.from(menu.querySelectorAll(MENU_ITEM_SELECTOR)).filter(isVisible);
    return items.filter((item) =>
      !items.some((other) => other !== item && other.contains(item))
    );
  }

  function waitFor(getValue, timeoutMs, stableMs = 0) {
    return new Promise((resolve, reject) => {
      let finished = false;
      let matchingSince = null;
      let pollTimer;
      let stableTimer;
      let timeoutTimer;
      const observer = new MutationObserver(check);

      function finish(value, error) {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearTimeout(pollTimer);
        clearTimeout(stableTimer);
        clearTimeout(timeoutTimer);
        if (error) reject(error);
        else resolve(value);
      }

      function check() {
        if (finished) return;
        let value;
        try {
          value = getValue();
        } catch (error) {
          finish(null, error);
          return;
        }
        if (!value) {
          matchingSince = null;
          clearTimeout(stableTimer);
        } else if (!stableMs ||
          (matchingSince !== null && Date.now() - matchingSince >= stableMs)) {
          finish(value);
        } else if (matchingSince === null) {
          matchingSince = Date.now();
          stableTimer = setTimeout(check, stableMs);
        }
      }

      // Изменения DOM будят ожидание сразу. Опрос нужен для CSS-анимаций
      // и изменений свойств, которые не создают MutationObserver-событий.
      observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, characterData: true
      });
      timeoutTimer = setTimeout(() => finish(null), timeoutMs);
      function poll() {
        check();
        if (!finished) pollTimer = setTimeout(poll, STATE_POLL_MS);
      }
      poll();
    });
  }

  async function openModeMenu() {
    const picker = await waitFor(() => {
      const candidate = findModePicker();
      return isControlEnabled(candidate) ? candidate : null;
    }, UI_TIMEOUT_MS);
    if (!picker) {
      return null;
    }

    if (picker.getAttribute("aria-expanded") !== "true") {
      picker.click();
    }
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

  function readMenuItemSelected(item) {
    if (!item) {
      return null;
    }

    for (const attribute of ["aria-checked", "aria-selected"]) {
      const value = item.getAttribute(attribute);
      if (value === "true" || value === "false") {
        return value === "true";
      }
    }
    const input = item.matches('input[type="radio"], input[type="checkbox"]')
      ? item
      : item.querySelector('input[type="radio"], input[type="checkbox"]');
    if (input) {
      return input.checked;
    }
    if (item.classList.contains("selected") ||
        item.querySelector('.selected, mat-icon[data-mat-icon-name="check"]')) {
      return true;
    }
    return item.tagName === "GEM-MENU-ITEM" || item.querySelector(".checkmark-only")
      ? false
      : null;
  }

  async function closeModeMenu() {
    const picker = findModePicker();
    if (!picker) {
      return;
    }

    const menu = findModeMenu(picker);
    if (picker.getAttribute("aria-expanded") === "true") {
      // Повторный click() по кнопке не гарантирует закрытие popover Gemini.
      // Escape закрывает само меню, не переключая его обратно в открытое состояние.
      (menu || picker).dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", code: "Escape", keyCode: 27, which: 27,
        bubbles: true, cancelable: true
      }));
    }
    if (!await waitFor(() => isModeMenuClosed(menu), UI_TIMEOUT_MS)) {
      throw new Error("Gemini did not close the mode menu.");
    }
  }

  function isModeMenuClosed(previousMenu = null) {
    const picker = findModePicker();
    return Boolean(picker && picker.getAttribute("aria-expanded") !== "true" &&
      !findModeMenu(picker) && (!previousMenu || !isVisible(previousMenu)));
  }

  function getThinkingMenuInfo(items) {
    const options = items.map((item) => ({
      text: item.textContent,
      isModel: item.hasAttribute("data-mode-id"),
      isRadio: item.getAttribute("role") === "menuitemradio" ||
        item.getAttribute("role") === "radio" ||
        item.matches('input[type="radio"]') ||
        Boolean(item.querySelector('input[type="radio"]')),
      followsSeparator:
        item.previousElementSibling?.getAttribute("role") === "separator" ||
        item.previousElementSibling?.tagName === "MAT-DIVIDER"
    }));

    const info = core.findThinkingOptions(options);
    return info
      ? { kind: info.kind, items: info.indexes.map((index) => items[index]) }
      : null;
  }

  function readThinkingMenuState(info) {
    if (!info) {
      return null;
    }
    if (info.kind === "legacy") {
      const enabled = readMenuItemSelected(info.items[0]) ??
        Boolean(findModePicker()?.querySelector(".picker-secondary-text"));
      return { kind: "legacy", thinkingLevel: enabled ? "high" : "low" };
    }
    const selected = info.items.map(readMenuItemSelected);
    if (selected.filter((value) => value === true).length !== 1) {
      return null;
    }
    return {
      kind: "levels",
      thinkingLevel: core.THINKING_LEVELS[selected.indexOf(true)]
    };
  }

  function matchesThinkingState(state, targetLevel) {
    const expectedLevel = state?.kind === "legacy" && targetLevel !== "low"
      ? "high"
      : targetLevel;
    return Boolean(state && state.thinkingLevel === expectedLevel);
  }

  function createThinkingConfirmation(info, targetLevel) {
    if (!info || !readThinkingMenuState(info)) {
      return null;
    }
    if (info.kind === "legacy") {
      return { kind: "legacy", targetLevel };
    }

    // Уровень определяет позиция, а не значение подписи. Текст нужен только
    // для сверки с кнопкой после закрытия меню в рамках текущего применения.
    // Эти подписи не сохраняются в настройках или межзапусковом кэше.
    const labels = info.items.map((item) => core.normalizeText(
      item.querySelector(".label")?.textContent || item.textContent
    ));
    const targetLabel = labels[core.THINKING_LEVELS.indexOf(targetLevel)];
    return {
      kind: "levels",
      targetLevel,
      targetLabel: targetLabel && labels.filter((label) => label === targetLabel).length === 1
        ? targetLabel : null
    };
  }

  function matchesThinkingConfirmation(confirmation) {
    const picker = findModePicker();
    if (!confirmation || !picker) {
      return false;
    }

    if (picker.getAttribute("aria-expanded") === "true") {
      const state = readThinkingMenuState(getThinkingMenuInfo(getVisibleMenuItems()));
      return state?.kind === confirmation.kind &&
        matchesThinkingState(state, confirmation.targetLevel);
    }

    const badge = core.normalizeText(picker.querySelector(".picker-secondary-text")?.textContent);
    if (confirmation.kind === "legacy") {
      return Boolean(badge) === (confirmation.targetLevel !== "low");
    }
    return (confirmation.targetLevel === "low" && !badge) ||
      Boolean(confirmation.targetLabel && badge === confirmation.targetLabel);
  }

  function waitForStableSettings(confirmation, modelId) {
    return waitFor(() => {
      const picker = findModePicker();
      return isControlEnabled(picker) && readPickerState(picker).model === modelId &&
        isModeMenuClosed() && matchesThinkingConfirmation(confirmation);
    }, UI_TIMEOUT_MS, STATE_STABLE_MS);
  }

  async function selectModel(modelId, targetLevel) {
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
        continue;
      }

      const selection = await waitFor(() => {
        const readyItems = getVisibleMenuItems();
        if (!readThinkingMenuState(getThinkingMenuInfo(readyItems))) return null;
        let menuItem = findMenuItem(readyItems, model.menuPrefix);
        let effectiveModel = model;
        if (!menuItem && model.fallbackId) {
          const fallback = core.getModel(model.fallbackId);
          if (fallback) {
            menuItem = findMenuItem(readyItems, fallback.menuPrefix);
            effectiveModel = fallback;
          }
        }
        return menuItem && isControlEnabled(menuItem)
          ? { menuItem, effectiveModel, items: readyItems } : null;
      }, UI_TIMEOUT_MS);
      if (!selection) {
        throw new Error(`Could not find the ${model.label} model option.`);
      }
      const { menuItem, effectiveModel } = selection;

      const thinkingConfirmation = createThinkingConfirmation(
        getThinkingMenuInfo(selection.items), targetLevel
      );
      if (currentModel === effectiveModel.id) {
        return { modelId: effectiveModel.id, changed: false, thinkingConfirmation };
      }

      menuItem.click();

      const applied = await waitFor(() => {
        const picker = findModePicker();
        return isControlEnabled(picker) && readPickerState(picker).model === effectiveModel.id;
      }, UI_TIMEOUT_MS);

      if (applied) {
        await closeModeMenu();
        return { modelId: effectiveModel.id, changed: true, thinkingConfirmation };
      }
    }

    throw new Error(`Gemini did not confirm the ${model.label} model.`);
  }

  async function setThinkingLevel(targetLevel) {
    if (!await openModeMenu()) {
      throw new Error("Could not open the mode menu.");
    }
    const ready = await waitFor(() => {
      const info = getThinkingMenuInfo(getVisibleMenuItems());
      const confirmation = createThinkingConfirmation(info, targetLevel);
      if (!confirmation) return null;
      const selected = matchesThinkingState(readThinkingMenuState(info), targetLevel);
      const targetItem = info.items[info.kind === "legacy"
        ? 0 : core.THINKING_LEVELS.indexOf(targetLevel)];
      return selected || (isControlEnabled(targetItem) &&
        (confirmation.kind === "legacy" || confirmation.targetLabel))
        ? { confirmation, targetItem, selected } : null;
    }, UI_TIMEOUT_MS);
    if (!ready) {
      throw new Error("The requested thinking level is not available or could not be verified.");
    }
    if (!ready.selected) ready.targetItem.click();
    return { changed: !ready.selected, confirmation: ready.confirmation };
  }

  async function applySettings(options = {}) {
    const targetSettings = options.settings || currentSettings;
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
    let thinkingConfirmation = null;
    let failed = true;

    try {
      for (let attempt = 0; attempt < MAX_INTERACTION_ATTEMPTS; attempt += 1) {
        const currentPicker = findModePicker();
        if (!currentPicker || readPickerState(currentPicker).model !== effectiveModelId) {
          const selectionResult = await selectModel(
            targetSettings.model, targetSettings.thinkingLevel
          );
          effectiveModelId = selectionResult.modelId;
          changed ||= selectionResult.changed;
          thinkingConfirmation = selectionResult.thinkingConfirmation;
        }

        if (!matchesThinkingConfirmation(thinkingConfirmation)) {
          const thinkingResult = await setThinkingLevel(targetSettings.thinkingLevel);
          changed ||= thinkingResult.changed;
          thinkingConfirmation = thinkingResult.confirmation;
        }
        await closeModeMenu();
        if (await waitForStableSettings(thinkingConfirmation, effectiveModelId)) {
          failed = false;
          return { applied: true, changed };
        }
      }
      throw new Error("Gemini did not confirm the final model settings.");
    } finally {
      if (findModePicker()?.getAttribute("aria-expanded") === "true") {
        await closeModeMenu();
      }
      if (isModeMenuClosed() &&
        (failed || changed || options.focusComposer || selectionSnapshot.wasFocused)) {
        await restoreEditorFocus(
          selectionSnapshot,
          options.timeoutMs || UI_TIMEOUT_MS
        );
      }
    }
  }

  function enqueueApply(options = {}) {
    const settings = options.settings || currentSettings;
    applyQueue = applyQueue
      .catch(() => undefined)
      .then(() => applySettings({ ...options, settings }));
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
      initialApplicationSettings = currentSettings;
      initialApplicationRequest = enqueueApply({ focusComposer: false });
      initialApplicationRequest
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
      ...rawSettings,
      ...(changes.model ? { model: changes.model.newValue } : {}),
      ...(changes.thinkingLevel
        ? { thinkingLevel: changes.thinkingLevel.newValue }
        : {}),
      ...(changes.extendedThinking
        ? { extendedThinking: changes.extendedThinking.newValue }
        : {})
    };
    rawSettings = nextSettings;
    currentSettings = core.normalizeSettings(nextSettings);
    // Синхронизация меняет значение по умолчанию, но не должна повторно
    // переключать уже открытую вкладку. Нужная вкладка получает одну явную
    // команду, а остальные сохраняют ручной выбор пользователя.
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === APPLY_MESSAGE) {
      currentSettings = core.normalizeSettings(message.settings);
      // Команда открытия новой вкладки может прийти после завершения startup.
      // Она использует тот же результат один раз; явное применение из popup остаётся отдельным.
      const initialRequest = (
        (!initialApplicationComplete && initialApplicationInProgress) || message.initialApplication === true
      ) &&
        initialApplicationSettings?.model === currentSettings.model &&
        initialApplicationSettings?.thinkingLevel === currentSettings.thinkingLevel
        ? initialApplicationRequest : null;
      stopInitialApplication();
      if (!initialRequest || message.initialApplication === true) {
        initialApplicationRequest = null;
        initialApplicationSettings = null;
      }
      const options = {
        settings: currentSettings,
        focusComposer: message.focusComposer !== false,
        timeoutMs: message.waitForUi ? COLD_START_UI_TIMEOUT_MS : undefined
      };
      const request = initialRequest
        ? initialRequest.then(async (result) => {
          if (!result?.applied) {
            return enqueueApply(options);
          }
          if (options.focusComposer) {
            await restoreEditorFocus(null, options.timeoutMs || UI_TIMEOUT_MS);
          }
          return result;
        }, () => enqueueApply(options))
        : enqueueApply(options);
      request
        .then((result) => {
          completeInitialApplication(result);
          sendResponse({ ok: true, ...result });
        })
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    return false;
  });

  chrome.storage.sync.get(core.STORAGE_KEYS, (storedSettings) => {
    rawSettings = storedSettings;
    currentSettings = core.normalizeSettings(storedSettings);
    if (initialApplicationComplete) {
      return;
    }
    watchForInitialPicker();
    scheduleInitialApply();
  });
})();
