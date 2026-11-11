(function initializeContentScript() {
  "use strict";

  const core = globalThis.GeminiDefaultModelCore;
  const APPLY_MESSAGE = "GEMINI_DEFAULT_MODEL_APPLY";
  const RETRY_DELAY_MS = 150;
  const UI_TIMEOUT_MS = 3500;
  const COLD_START_UI_TIMEOUT_MS = 30_000;
  const STARTUP_RESET_WINDOW_MS = 5000;
  const STATE_STABLE_MS = 200;
  const STATE_POLL_MS = 50;
  const MAX_INTERACTION_ATTEMPTS = 2;
  const MENU_ITEM_SELECTOR =
    '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="radio"], input[type="radio"]';
  const SUBMENU_TRIGGER_SELECTOR = '[aria-haspopup="menu"], [aria-haspopup="true"]';

  let currentSettings = core.DEFAULT_SETTINGS;
  let rawSettings = {};
  let applyQueue = Promise.resolve();
  let latestApplyId = 0;
  let scheduledTimer = null;
  let initialApplicationComplete = false;
  let initialApplicationInProgress = false;
  let initialApplicationRequest = null;
  let initialApplicationSettings = null;
  let initialObserver = null;
  let startupResetWatch = null;

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

  function ensureApplicationActive(isCancelled) {
    if (isCancelled?.()) throw new Error("Startup recovery was cancelled by user interaction.");
  }

  function readPickerState(picker) {
    const badge = picker.querySelector(".picker-secondary-text");
    const text = picker.textContent || "";
    // При перерисовке aria-label может ещё называть предыдущую модель.
    // Видимая подпись без thinking-бейджа приоритетнее этого запасного источника.
    const visibleState = core.inferPickerState(
      badge?.textContent ? text.replace(badge.textContent, " ") : text
    );
    return visibleState.model ? visibleState :
      core.inferPickerState(picker.getAttribute("aria-label") || "");
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

  function captureEditorFocus() {
    const editor = findPromptEditor();
    const activeElement = document.activeElement;
    return Boolean(
      editor && (activeElement === editor || editor.contains(activeElement))
    );
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

  async function restoreEditorFocus(timeoutMs = UI_TIMEOUT_MS, isCancelled) {
    const editor = await waitFor(findPromptEditor, timeoutMs, 0, isCancelled);
    if (!editor || isCancelled?.()) {
      return false;
    }

    editor.focus({ preventScroll: true });

    if (editor instanceof HTMLTextAreaElement) {
      const caretPosition = editor.value.length;
      editor.setSelectionRange(caretPosition, caretPosition);
      return true;
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
          core.MODEL_OPTIONS.some((model) => findMenuItem([item], model))
        )
      );
      menu = menus.length === 1 ? menus[0] : null;
    }
    return menu;
  }

  function getMenuItems(menu) {
    const items = Array.from(menu.querySelectorAll(
      `${MENU_ITEM_SELECTOR}, ${SUBMENU_TRIGGER_SELECTOR}`
    )).filter(isVisible);
    return items.filter((item) =>
      !items.some((other) => other !== item && other.contains(item))
    );
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

    return getMenuItems(menu);
  }

  function getSubmenuTrigger(item) {
    return item.matches(SUBMENU_TRIGGER_SELECTOR)
      ? item : item.querySelector(SUBMENU_TRIGGER_SELECTOR);
  }

  function findThinkingSubmenuTrigger(items = getVisibleMenuItems()) {
    const triggers = items.filter((item) =>
      !item.hasAttribute("data-mode-id") &&
      !core.MODEL_OPTIONS.some((model) => findMenuItem([item], model))
    ).map(getSubmenuTrigger).filter(Boolean);
    return triggers.length === 1 ? triggers[0] : null;
  }

  function findThinkingSubmenu(trigger = findThinkingSubmenuTrigger()) {
    if (!trigger) return null;
    const controlledIds = `${trigger.getAttribute("aria-controls") || ""} ${
      trigger.getAttribute("aria-owns") || ""
    }`.trim().split(/\s+/).filter(Boolean);
    const controlled = controlledIds.map((id) => document.getElementById(id))
      .find((element) => element && isVisible(element));
    if (controlled) return controlled;

    const triggerId = trigger.getAttribute("id");
    const candidates = Array.from(document.querySelectorAll('[role="menu"]'))
      .filter((menu) => isVisible(menu) && (trigger.contains(menu) ||
        (triggerId && (menu.getAttribute("aria-labelledby") || "").split(/\s+/).includes(triggerId))));
    return candidates.length === 1 ? candidates[0] : null;
  }

  function getVisibleThinkingMenuInfo() {
    const items = getVisibleMenuItems();
    const submenu = findThinkingSubmenu(findThinkingSubmenuTrigger(items));
    return getThinkingMenuInfo(submenu ? getMenuItems(submenu) : items);
  }

  async function openThinkingMenu(timeoutMs = UI_TIMEOUT_MS, isCancelled) {
    if (!await openModeMenu(timeoutMs, isCancelled)) return null;
    const ready = await waitFor(() => {
      const items = getVisibleMenuItems();
      const trigger = findThinkingSubmenuTrigger(items);
      if (trigger) return isControlEnabled(trigger) ? { trigger } : null;
      return readThinkingMenuState(getThinkingMenuInfo(items)) ? {} : null;
    }, timeoutMs, 0, isCancelled);
    if (!ready) return null;
    ensureApplicationActive(isCancelled);
    if (ready.trigger && !findThinkingSubmenu(ready.trigger)) {
      ready.trigger.click();
      if (!findThinkingSubmenu(ready.trigger) && ready.trigger.getAttribute("aria-expanded") !== "true") {
        // Некоторые варианты меню открывают вложенный список только наведением.
        ready.trigger.dispatchEvent(new MouseEvent("mouseenter"));
        ready.trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      }
    }
    return waitFor(() => {
      const info = getVisibleThinkingMenuInfo();
      return readThinkingMenuState(info) ? info : null;
    }, timeoutMs, 0, isCancelled);
  }

  function waitFor(getValue, timeoutMs, stableMs = 0, isCancelled) {
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
        if (isCancelled?.()) {
          finish(null);
          return;
        }
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

  async function openModeMenu(timeoutMs = UI_TIMEOUT_MS, isCancelled) {
    const picker = await waitFor(() => {
      const candidate = findModePicker();
      return isControlEnabled(candidate) ? candidate : null;
    }, timeoutMs, 0, isCancelled);
    if (!picker) {
      return null;
    }
    ensureApplicationActive(isCancelled);

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
    }, timeoutMs, 0, isCancelled);
  }

  function findMenuItem(items, model) {
    return items.find((item) => {
      // В новом меню описание идёт перед моделью, а textContent соседних
      // элементов может склеиваться без пробела. Проверяем и отдельные подписи.
      const labels = [item.textContent, item.getAttribute("aria-label"),
        ...Array.from(item.querySelectorAll(".label, .sublabel, span"))
          .map((label) => label.textContent)];
      return labels.some((label) => core.matchesModelText(label, model));
    }) || null;
  }

  function isModelOptionEnabled(item) {
    if (!isControlEnabled(item) || item.hasAttribute("disabled") ||
        item.querySelector('[aria-disabled="true"], [disabled]')) {
      return false;
    }
    // Заблокированная подпиской модель может оставаться кликабельной,
    // открывая предложение обновить тариф вместо переключения модели.
    return !Array.from(item.querySelectorAll(
      'mat-icon, [data-mat-icon-name], [fonticon]'
    )).some((icon) => isVisible(icon) && [
      icon.getAttribute("data-mat-icon-name"), icon.getAttribute("fonticon"),
      core.normalizeText(icon.textContent)
    ].some((name) => name === "lock" || name === "lock_outline"));
  }

  function findModelOption(items, model) {
    const item = findMenuItem(items, model);
    if (item) return { item, model };
    const fallback = core.getModel(model.fallbackId);
    const fallbackItem = fallback && findMenuItem(items, fallback);
    return fallbackItem ? { item: fallbackItem, model: fallback } : null;
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

  async function closeModeMenu(previousSubmenu = null, isCancelled) {
    if (isCancelled?.()) return;
    const picker = findModePicker();
    if (!picker) {
      return;
    }

    const menu = findModeMenu(picker);
    const submenu = findThinkingSubmenu() || previousSubmenu;
    if (submenu && isVisible(submenu)) {
      // Вложенный popover может поглощать Escape: сначала закрываем его,
      // затем родительское меню, если оно осталось открытым.
      submenu.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", code: "Escape", keyCode: 27, which: 27,
        bubbles: true, cancelable: true
      }));
      const closed = await waitFor(() => !isVisible(submenu), UI_TIMEOUT_MS, 0, isCancelled);
      if (isCancelled?.()) return;
      if (!closed) {
        throw new Error("Gemini did not close the thinking submenu.");
      }
    }
    if (isCancelled?.()) return;
    const currentPicker = findModePicker() || picker;
    if (currentPicker.getAttribute("aria-expanded") === "true") {
      // Повторный click() по кнопке не гарантирует закрытие popover Gemini.
      // Escape закрывает само меню, не переключая его обратно в открытое состояние.
      (findModeMenu(currentPicker) || currentPicker).dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", code: "Escape", keyCode: 27, which: 27,
        bubbles: true, cancelable: true
      }));
    }
    const closed = await waitFor(() => isModeMenuClosed(menu), UI_TIMEOUT_MS, 0, isCancelled);
    if (isCancelled?.()) return;
    if (!closed) {
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
      isModel: item.hasAttribute("data-mode-id") ||
        core.MODEL_OPTIONS.some((model) => findMenuItem([item], model)),
      isSubmenu: Boolean(getSubmenuTrigger(item)),
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
      submenu: findThinkingSubmenu(),
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
      const state = readThinkingMenuState(getVisibleThinkingMenuInfo());
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

  function waitForStableSettings(confirmation, modelId, timeoutMs, isCancelled) {
    return waitFor(() => {
      const picker = findModePicker();
      return isControlEnabled(picker) && readPickerState(picker).model === modelId &&
        isModeMenuClosed() && (!confirmation?.submenu || !isVisible(confirmation.submenu)) &&
        matchesThinkingConfirmation(confirmation);
    }, timeoutMs, STATE_STABLE_MS, isCancelled);
  }

  async function selectModel(modelId, targetLevel, timeoutMs = UI_TIMEOUT_MS, isCancelled) {
    const model = core.getModel(modelId);
    if (!model) {
      throw new Error(`Unknown model: ${modelId}`);
    }

    for (let attempt = 0; attempt < MAX_INTERACTION_ATTEMPTS; attempt += 1) {
      ensureApplicationActive(isCancelled);
      const pickerBefore = findModePicker();
      const currentModel = pickerBefore
        ? readPickerState(pickerBefore).model
        : null;
      if (currentModel === modelId) {
        return { modelId, changed: false };
      }

      const items = await openModeMenu(timeoutMs, isCancelled);
      if (!items) {
        continue;
      }

      const selection = await waitFor(() => {
        const option = findModelOption(getVisibleMenuItems(), model);
        return option && isModelOptionEnabled(option.item) ? option : null;
      }, timeoutMs, 0, isCancelled);
      if (!selection) {
        const unavailable = findModelOption(getVisibleMenuItems(), model);
        if (unavailable && !isModelOptionEnabled(unavailable.item)) {
          throw new Error(`${unavailable.model.label} is unavailable for this account. Choose another model.`);
        }
        throw new Error(`Could not find the ${model.label} model option.`);
      }
      const effectiveModel = selection.model;

      // Если уровни уже видны, их подписи помогают избежать лишнего открытия.
      // Их наличие у старой модели не должно блокировать выбор новой модели.
      const thinkingConfirmation = createThinkingConfirmation(getVisibleThinkingMenuInfo(), targetLevel);
      if (currentModel === effectiveModel.id) {
        return { modelId: effectiveModel.id, changed: false, thinkingConfirmation };
      }

      // Ожидание доступности может сопровождаться перерисовкой пунктов меню.
      const menuItem = await waitFor(() => {
        const item = findMenuItem(getVisibleMenuItems(), effectiveModel);
        return item && isModelOptionEnabled(item) ? item : null;
      }, timeoutMs, 0, isCancelled);
      if (!menuItem) {
        const item = findMenuItem(getVisibleMenuItems(), effectiveModel);
        if (item && !isModelOptionEnabled(item)) {
          throw new Error(`${effectiveModel.label} is unavailable for this account. Choose another model.`);
        }
        throw new Error(`Could not find the ${effectiveModel.label} model option.`);
      }
      ensureApplicationActive(isCancelled);
      menuItem.click();

      const applied = await waitFor(() => {
        const picker = findModePicker();
        return isControlEnabled(picker) && readPickerState(picker).model === effectiveModel.id;
      }, timeoutMs, 0, isCancelled);

      if (applied) {
        ensureApplicationActive(isCancelled);
        await closeModeMenu(thinkingConfirmation?.submenu, isCancelled);
        return { modelId: effectiveModel.id, changed: true, thinkingConfirmation };
      }
    }

    throw new Error(`Gemini did not confirm the ${model.label} model.`);
  }

  async function setThinkingLevel(targetLevel, timeoutMs = UI_TIMEOUT_MS, isCancelled) {
    if (!await openThinkingMenu(timeoutMs, isCancelled)) {
      throw new Error("The requested thinking level is not available or could not be verified.");
    }
    const ready = await waitFor(() => {
      const info = getVisibleThinkingMenuInfo();
      const confirmation = createThinkingConfirmation(info, targetLevel);
      if (!confirmation) return null;
      const selected = matchesThinkingState(readThinkingMenuState(info), targetLevel);
      const targetItem = info.items[info.kind === "legacy"
        ? 0 : core.THINKING_LEVELS.indexOf(targetLevel)];
      return selected || (isControlEnabled(targetItem) &&
        (confirmation.kind === "legacy" || confirmation.targetLabel))
        ? { confirmation, targetItem, selected } : null;
    }, timeoutMs, 0, isCancelled);
    if (!ready) {
      throw new Error("The requested thinking level is not available or could not be verified.");
    }
    ensureApplicationActive(isCancelled);
    if (!ready.selected) ready.targetItem.click();
    return { changed: !ready.selected, confirmation: ready.confirmation };
  }

  async function applySettings(options = {}) {
    if (options.isCancelled?.()) {
      return { applied: false, cancelled: true, reason: "Startup recovery was cancelled by user interaction." };
    }
    const targetSettings = options.settings || currentSettings;
    const timeoutMs = options.timeoutMs || UI_TIMEOUT_MS;
    const picker = await waitFor(
      findModePicker,
      timeoutMs, 0, options.isCancelled
    );
    if (options.isCancelled?.()) {
      return { applied: false, cancelled: true, reason: "Startup recovery was cancelled by user interaction." };
    }
    if (!picker) {
      return { applied: false, reason: "The Gemini interface is not ready yet." };
    }

    const editorWasFocused = captureEditorFocus();
    let changed = false;
    let effectiveModelId = targetSettings.model;
    let thinkingConfirmation = null;
    let failed = true;

    try {
      for (let attempt = 0; attempt < MAX_INTERACTION_ATTEMPTS; attempt += 1) {
        const currentPicker = findModePicker();
        ensureApplicationActive(options.isCancelled);
        if (!currentPicker || readPickerState(currentPicker).model !== effectiveModelId) {
          const selectionResult = await selectModel(
            targetSettings.model, targetSettings.thinkingLevel, timeoutMs, options.isCancelled
          );
          effectiveModelId = selectionResult.modelId;
          changed ||= selectionResult.changed;
          thinkingConfirmation = selectionResult.thinkingConfirmation;
        }

        if (!matchesThinkingConfirmation(thinkingConfirmation)) {
          const thinkingResult = await setThinkingLevel(
            targetSettings.thinkingLevel, timeoutMs, options.isCancelled
          );
          changed ||= thinkingResult.changed;
          thinkingConfirmation = thinkingResult.confirmation;
        }
        ensureApplicationActive(options.isCancelled);
        await closeModeMenu(thinkingConfirmation?.submenu, options.isCancelled);
        if (await waitForStableSettings(thinkingConfirmation, effectiveModelId, timeoutMs, options.isCancelled)) {
          failed = false;
          if (options.initialApplication && options.applyId === latestApplyId) {
            watchForStartupReset(targetSettings, thinkingConfirmation, effectiveModelId);
          }
          return { applied: true, changed };
        }
      }
      throw new Error("Gemini did not confirm the final model settings.");
    } catch (error) {
      if (options.isCancelled?.()) return { applied: false, cancelled: true, reason: error.message };
      throw error;
    } finally {
      if (!options.isCancelled?.() && (findModePicker()?.getAttribute("aria-expanded") === "true" ||
          (thinkingConfirmation?.submenu && isVisible(thinkingConfirmation.submenu)))) {
        await closeModeMenu(thinkingConfirmation?.submenu, options.isCancelled);
      }
      if (!options.isCancelled?.() && isModeMenuClosed() &&
        (!thinkingConfirmation?.submenu || !isVisible(thinkingConfirmation.submenu)) &&
        (failed || changed || options.focusComposer || editorWasFocused)) {
        await restoreEditorFocus(options.timeoutMs || UI_TIMEOUT_MS, options.isCancelled);
      }
    }
  }

  function enqueueApply(options = {}) {
    const settings = options.settings || currentSettings;
    const applyId = ++latestApplyId;
    applyQueue = applyQueue
      .catch(() => undefined)
      .then(() => applySettings({ ...options, settings, applyId }));
    return applyQueue;
  }

  function stopStartupResetWatch() {
    startupResetWatch?.cancel();
    startupResetWatch = null;
  }

  function watchForStartupReset(settings, confirmation, modelId) {
    stopStartupResetWatch();
    let cancelled = false;
    let recovering = false;
    let mismatchTimer = null;
    let expiryTimer;
    const interactionEvents = ["pointerdown", "keydown", "input"];
    const observer = new MutationObserver(check);
    const watch = { cancel };
    startupResetWatch = watch;

    function cleanup() {
      observer.disconnect();
      clearTimeout(mismatchTimer);
      clearTimeout(expiryTimer);
      for (const type of interactionEvents) {
        document.removeEventListener(type, onInteraction, true);
      }
      if (startupResetWatch === watch) startupResetWatch = null;
    }

    function cancel() {
      cancelled = true;
      cleanup();
    }

    function onInteraction(event) {
      // Наши click()/Escape синтетические. Реальный ввод сразу отдаёт
      // управление пользователю, включая уже поставленное в очередь восстановление.
      if (event.isTrusted) cancel();
    }

    function needsRecovery() {
      const picker = findModePicker();
      return isControlEnabled(picker) && isModeMenuClosed() &&
        (readPickerState(picker).model !== modelId || !matchesThinkingConfirmation(confirmation));
    }

    function check() {
      if (cancelled || recovering) return;
      if (!needsRecovery()) {
        clearTimeout(mismatchTimer);
        mismatchTimer = null;
      } else if (mismatchTimer === null) {
        mismatchTimer = setTimeout(recover, STATE_STABLE_MS);
      }
    }

    function recover() {
      mismatchTimer = null;
      if (cancelled || !needsRecovery()) return;
      recovering = true;
      observer.disconnect();
      clearTimeout(expiryTimer);
      // Gemini может закончить загрузку или сбросить thinking уже после
      // успешной проверки. Разрешаем одно восстановление, без вечного автопереключения.
      const request = enqueueApply({
        settings, timeoutMs: COLD_START_UI_TIMEOUT_MS, isCancelled: () => cancelled
      });
      if (initialApplicationSettings === settings) initialApplicationRequest = request;
      request.catch((error) => {
        console.debug("[Gemini Default Model Selector]", error.message);
      }).finally(cleanup);
    }

    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, characterData: true
    });
    for (const type of interactionEvents) {
      document.addEventListener(type, onInteraction, true);
    }
    expiryTimer = setTimeout(cancel, STARTUP_RESET_WINDOW_MS);
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
      initialApplicationRequest = enqueueApply({
        focusComposer: false, initialApplication: true, timeoutMs: COLD_START_UI_TIMEOUT_MS
      });
      initialApplicationRequest
        .then((result) => {
          stopInitialApplication();
          if (!result?.applied) {
            console.debug("[Gemini Default Model Selector]", result?.reason || "The settings were not applied.");
          }
        })
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
    latestApplyId += 1;
    stopStartupResetWatch();
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
      if (!initialRequest) stopStartupResetWatch();
      if (!initialRequest || message.initialApplication === true) {
        initialApplicationRequest = null;
        initialApplicationSettings = null;
      }
      const options = {
        settings: currentSettings,
        focusComposer: message.focusComposer !== false,
        initialApplication: message.initialApplication === true,
        timeoutMs: message.waitForUi ? COLD_START_UI_TIMEOUT_MS : undefined
      };
      const request = initialRequest
        ? initialRequest.then(async (result) => {
          if (result?.cancelled) return result;
          if (!result?.applied) {
            return enqueueApply(options);
          }
          if (options.focusComposer) {
            await restoreEditorFocus(options.timeoutMs || UI_TIMEOUT_MS);
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
    // Пока чтение было в полёте, onChanged мог принести более свежие поля,
    // включая удаление ключа (undefined). Поздний снимок не должен их затирать.
    rawSettings = { ...storedSettings, ...rawSettings };
    if (initialApplicationComplete) {
      return;
    }
    currentSettings = core.normalizeSettings(rawSettings);
    watchForInitialPicker();
    scheduleInitialApply();
  });
})();
