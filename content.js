(function initializeContentScript() {
  "use strict";

  const core = globalThis.GeminiDefaultModelCore;
  const APPLY_MESSAGE = "GEMINI_DEFAULT_MODEL_APPLY";
  const RETRY_DELAY_MS = 150;
  const OPEN_RETRY_MS = 400;
  const UI_TIMEOUT_MS = 3500;
  const COLD_START_UI_TIMEOUT_MS = 30_000;
  const STARTUP_RESET_WINDOW_MS = 5000;
  const STATE_STABLE_MS = 200;
  const STATE_POLL_MS = 50;
  const MAX_INTERACTION_ATTEMPTS = 2;
  const MAX_STARTUP_RECOVERIES = 2;
  const MENU_ITEM_SELECTOR =
    '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="radio"], input[type="radio"]';
  const SUBMENU_TRIGGER_SELECTOR = '[aria-haspopup="menu"], [aria-haspopup="true"]';
  const EDITOR_SELECTOR =
    '[role="textbox"], .ql-editor, textarea';
  const COMPOSER_SELECTOR = 'input-container, .input-area-container, [data-test-id="input-area"]';
  const PICKER_DECORATION_SELECTOR =
    '.picker-secondary-text, mat-icon, svg, [role="img"], [data-mat-icon-name], [fonticon], .material-icons';

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
  let lastModeMenu = null;
  let modelCatalog = [];

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (!element.getClientRects().length) return false;
    for (let node = element; node instanceof HTMLElement && node !== document; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" ||
          style.opacity === "0" || node.getAttribute("aria-hidden") === "true") return false;
    }
    return true;
  }

  function getEditorCandidates() {
    return Array.from(document.querySelectorAll(EDITOR_SELECTOR)).filter((element) =>
      isVisible(element) && (element instanceof HTMLTextAreaElement || element.isContentEditable)
    );
  }

  function chooseModePicker(candidates) {
    for (const matches of [
      candidates.filter((button) => button.classList.contains("input-area-switch")),
      candidates.filter((button) =>
        (button.getAttribute("aria-label") || "").toLocaleLowerCase("en-US").includes("mode picker")
      ),
      candidates.filter((button) => readPickerState(button).model !== null)
    ]) {
      if (matches.length) return matches.length === 1 ? matches[0] : null;
    }
    return null;
  }

  function isBroadContainer(element) {
    return element === document.documentElement || element.matches('body, main, [role="main"]');
  }

  function findModePicker() {
    const candidates = document.querySelectorAll(
      'button[aria-haspopup="true"], button[aria-haspopup="menu"], button.input-area-switch'
    );

    const visible = Array.from(candidates).filter(isVisible);
    const scopedPickers = new Set();
    const knownPickers = new Set();
    let hasKnownComposer = false;
    let hasScopedCandidates = false;
    for (const editor of getEditorCandidates()) {
      const composer = editor.closest(COMPOSER_SELECTOR);
      if (composer) {
        hasKnownComposer = true;
        const picker = chooseModePicker(visible.filter((button) => composer.contains(button)));
        if (picker) knownPickers.add(picker);
        continue;
      }
      // Ближайший общий контейнер поля и кнопки надёжнее поиска по всей странице.
      // main/body не считаем композитором: туда попадают сайдбар и другие формы.
      for (let scope = editor.parentElement; scope && !isBroadContainer(scope); scope = scope.parentElement) {
        const local = visible.filter((button) => scope.contains(button));
        if (local.some((button) => chooseModePicker([button]))) {
          hasScopedCandidates = true;
          const picker = chooseModePicker(local);
          if (picker) scopedPickers.add(picker);
          break;
        }
      }
    }
    if (hasKnownComposer) return knownPickers.size === 1 ? [...knownPickers][0] : null;
    if (scopedPickers.size) return scopedPickers.size === 1 ? [...scopedPickers][0] : null;
    if (hasScopedCandidates) return null;
    const fallback = visible.filter((button) => chooseModePicker([button]));
    return fallback.length === 1 ? fallback[0] : null;
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
    const modeId = getSiteModeId(picker);
    const model = modeId && modelCatalog.find((entry) => entry.modeId === modeId);
    if (model) return { model: model.id };

    function readLabel(node) {
      if (node.nodeType === 3) return node.textContent || "";
      if (node.matches?.(PICKER_DECORATION_SELECTOR)) return "";
      return Array.from(node.childNodes || []).map(readLabel).join(" ");
    }
    const text = readLabel(picker);
    // При перерисовке aria-label может ещё называть предыдущую модель.
    // Видимая подпись без thinking-бейджа приоритетнее этого запасного источника.
    const visibleState = core.inferPickerState(text, modelCatalog);
    return visibleState.model || visibleState.ambiguous ? visibleState :
      core.inferPickerState(picker.getAttribute("aria-label") || "", modelCatalog);
  }

  function findPromptEditor() {
    const editors = getEditorCandidates().filter((element) =>
      isControlEnabled(element) && !element.readOnly
    );
    const picker = findModePicker();
    if (picker) {
      for (let scope = picker.parentElement; scope && !isBroadContainer(scope); scope = scope.parentElement) {
        const local = editors.filter((editor) => scope.contains(editor));
        if (local.length) return local.length === 1 ? local[0] : null;
        if (scope.matches(COMPOSER_SELECTOR)) return null;
      }
    }
    return editors.length === 1 ? editors[0] : null;
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
    // activeElement остаётся полем даже после перехода в панель Chrome.
    // Не отбираем фокус у popup, адресной строки или другой вкладки.
    if (document.hidden || !document.hasFocus()) return false;
    const editor = await waitFor(findPromptEditor, timeoutMs, 0, isCancelled);
    if (!editor || isCancelled?.() || document.hidden || !document.hasFocus()) {
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
      const visibleMenus = Array.from(document.querySelectorAll(
        '[data-test-id="gem-mode-menu"], [role="menu"]'
      )).filter(isVisible);
      const exactMenus = visibleMenus.filter((candidate) =>
        candidate.getAttribute("data-test-id") === "gem-mode-menu"
      );
      if (exactMenus.length) {
        menu = exactMenus.length === 1 ? exactMenus[0] : null;
        if (menu) lastModeMenu = menu;
        return menu;
      }
      if (picker.getAttribute("aria-expanded") !== "true") {
        // После закрытия чужое меню с названием модели не относится к picker.
        // Проверяем только ранее найденный popover, пока завершается его анимация.
        if (lastModeMenu && !isVisible(lastModeMenu)) lastModeMenu = null;
        return lastModeMenu;
      }
      const menus = visibleMenus.filter((candidate) =>
        Array.from(candidate.querySelectorAll(MENU_ITEM_SELECTOR)).some((item) =>
          isModelItem(item)
        )
      );
      menu = menus.length === 1 ? menus[0] : null;
    }
    if (menu) lastModeMenu = menu;
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
      !isModelItem(item)
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
    if (candidates.length) return candidates.length === 1 ? candidates[0] : null;
    // CDK может вынести submenu в отдельный overlay без ARIA-связи.
    // Фоллбэк допустим лишь для раскрытого триггера и единственной полной группы уровней.
    if (trigger.getAttribute("aria-expanded") !== "true") return null;
    const modeMenu = findModeMenu();
    const overlays = Array.from(document.querySelectorAll('[role="menu"]')).filter((menu) =>
      isVisible(menu) && menu !== modeMenu && !menu.contains(modeMenu) &&
      getThinkingMenuInfo(getMenuItems(menu))?.kind === "levels"
    );
    return overlays.length === 1 ? overlays[0] : null;
  }

  function getVisibleThinkingMenuInfo() {
    const items = getVisibleMenuItems();
    const submenu = findThinkingSubmenu(findThinkingSubmenuTrigger(items));
    return getThinkingMenuInfo(submenu ? getMenuItems(submenu) : items);
  }

  async function openThinkingMenu(timeoutMs = UI_TIMEOUT_MS, isCancelled) {
    if (!await openModeMenu(timeoutMs, isCancelled)) return null;
    let nextActionAt = 0;
    let previousTrigger = null;
    let tryHover = false;
    return waitFor(() => {
      const items = getVisibleMenuItems();
      const trigger = findThinkingSubmenuTrigger(items);
      const submenu = findThinkingSubmenu(trigger);
      const info = getThinkingMenuInfo(submenu ? getMenuItems(submenu) : items);
      if (readThinkingMenuState(info)) return info;
      if (!trigger || submenu || !isControlEnabled(trigger) ||
          trigger.getAttribute("aria-expanded") === "true" || Date.now() < nextActionAt) return null;
      ensureApplicationActive(isCancelled);
      if (trigger !== previousTrigger) tryHover = false;
      previousTrigger = trigger;
      nextActionAt = Date.now() + OPEN_RETRY_MS;
      if (tryHover) {
        // Некоторые варианты меню открывают вложенный список только наведением.
        trigger.dispatchEvent(new MouseEvent("mouseenter"));
        trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      } else {
        trigger.click();
      }
      tryHover = !tryHover;
      return null;
    }, timeoutMs, 0, isCancelled);
  }

  function waitFor(getValue, timeoutMs, stableMs = 0, isCancelled) {
    return new Promise((resolve, reject) => {
      let finished = false;
      let matchingSince = null;
      let pollTimer;
      let stableTimer;
      let timeoutTimer;
      let remainingMs = timeoutMs;
      let timeoutStartedAt = null;
      const observer = new MutationObserver(check);

      function finish(value, error) {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearTimeout(pollTimer);
        clearTimeout(stableTimer);
        clearTimeout(timeoutTimer);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        if (error) reject(error);
        else resolve(value);
      }

      function onVisibilityChange() {
        clearTimeout(timeoutTimer);
        if (timeoutStartedAt !== null) remainingMs -= Date.now() - timeoutStartedAt;
        timeoutStartedAt = null;
        // Фоновая вкладка может не гидратироваться, а её таймеры замедляются Chrome.
        // Считаем только время видимости; успешное применение в фоне всё ещё разрешено.
        if (!document.hidden) {
          timeoutStartedAt = Date.now();
          timeoutTimer = setTimeout(() => {
            check();
            if (!finished) finish(null);
          }, Math.max(0, remainingMs));
        }
        check();
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
      document.addEventListener("visibilitychange", onVisibilityChange);
      onVisibilityChange();
      function poll() {
        check();
        if (!finished) pollTimer = setTimeout(poll, STATE_POLL_MS);
      }
      poll();
    });
  }

  async function openModeMenu(timeoutMs = UI_TIMEOUT_MS, isCancelled) {
    let nextClickAt = 0;
    return waitFor(() => {
      const picker = findModePicker();
      const items = getVisibleMenuItems();
      if (picker?.getAttribute("aria-expanded") === "true" && items.length) return items;
      if (isControlEnabled(picker) && picker.getAttribute("aria-expanded") !== "true" &&
          Date.now() >= nextClickAt) {
        ensureApplicationActive(isCancelled);
        nextClickAt = Date.now() + OPEN_RETRY_MS;
        picker.click();
      }
      return null;
    }, timeoutMs, 0, isCancelled);
  }

  function findMenuItem(items, model) {
    if (model.modeId) {
      const identified = items.filter((item) => getSiteModeId(item) === model.modeId);
      if (identified.length) return identified.length === 1 ? identified[0] : null;
    }
    const matches = items.filter((item) => {
      const modeId = getSiteModeId(item);
      if (model.id.startsWith("mode:") || (model.modeId && modeId) ||
          (modeId && modelCatalog.some((entry) => entry.modeId === modeId && entry.id !== model.id))) {
        return false;
      }
      // В новом меню описание идёт перед моделью, а textContent соседних
      // элементов может склеиваться без пробела. Проверяем и отдельные подписи.
      const labels = [item.textContent, item.getAttribute("aria-label"),
        ...Array.from(item.querySelectorAll(".label, .sublabel, span"))
          .map((label) => label.textContent)];
      return labels.some((label) => core.matchesModelText(label, model));
    });
    return matches.length === 1 ? matches[0] : null;
  }

  function getSiteModeId(item) {
    const modeId = item.getAttribute("data-mode-id") ||
      /^bard-mode-option-(.+)$/.exec(item.getAttribute("data-test-id") || "")?.[1];
    return core.isModeId(modeId) ? modeId : null;
  }

  function isModelItem(item) {
    return Boolean(getSiteModeId(item) ||
      core.MODEL_OPTIONS.some((model) => findMenuItem([item], model)));
  }

  function readCatalogEntries(modelRows, previousCatalog) {
    const rows = modelRows.map((item) => ({
      item,
      modeId: getSiteModeId(item),
      primary: core.normalizeText(item.querySelector(".label, .mdc-list-item__primary-text")?.textContent),
      secondary: core.normalizeText(item.querySelector(".sublabel, .mdc-list-item__secondary-text")?.textContent),
      text: core.normalizeText(item.getAttribute("aria-label") || item.textContent)
    }));
    // В текущем меню название находится под описанием. В старом варианте
    // порядок обратный, а Auto и в новом меню остаётся основным заголовком.
    const versioned = (text) => /^\d+(?:\.\d+)*\s+\S/.test(text);
    const descriptionFirst = rows.some(({ secondary }) => versioned(secondary)) &&
      !rows.some(({ primary }) => versioned(primary));
    const entries = rows.map(({ item, modeId, primary, secondary, text }) => {
      const auto = modeId === core.AUTO_MODE_ID || /^auto$/i.test(primary || text);
      const cached = modeId && !modeId.startsWith("upsell_") &&
        previousCatalog.find((model) => model.modeId === modeId);
      const known = core.MODEL_OPTIONS.find((model) =>
        modeId === model.id || [primary, secondary, text].includes(model.label)
      );
      const label = auto ? primary || "Auto" :
        (descriptionFirst ? secondary || primary : primary || secondary) ||
        known?.label || text;
      const legacyFlash = ["flash-3.7", "flash-3.8"].includes(known?.id);
      const id = auto ? "auto" : legacyFlash && modeId ? `mode:${modeId}` :
        cached?.id || known?.id || (modeId && `mode:${modeId}`);
      return { id, label, modeId, available: isModelOptionEnabled(item) };
    });
    const catalog = core.readModelCatalog(entries);
    return catalog.length === rows.length ? catalog : [];
  }

  async function refreshModelCatalog(timeoutMs, isCancelled, open = true) {
    const stored = await chrome.storage.local.get(core.MODEL_CATALOG_KEY).catch(() => ({}));
    const previousCatalog = core.readModelCatalog(stored[core.MODEL_CATALOG_KEY]);
    if (isCancelled?.()) return;
    if (open && !await openModeMenu(timeoutMs, isCancelled)) return;

    let previousSignature = null;
    let since = 0;
    const catalog = await waitFor(() => {
      const modelRows = getVisibleMenuItems().filter(isModelItem);
      const reportsSelection = modelRows.length && modelRows.every((item) => item.hasAttribute("aria-checked"));
      const ambiguousSelection = reportsSelection &&
        modelRows.filter((item) => item.getAttribute("aria-checked") === "true").length > 1;
      const entries = ambiguousSelection ? [] : readCatalogEntries(modelRows, previousCatalog);
      const signature = entries.some(({ available }) => available) ? JSON.stringify(entries) : null;
      if (signature !== previousSignature) {
        previousSignature = signature;
        since = Date.now();
      }
      return signature && Date.now() - since >= STATE_STABLE_MS ? entries : null;
    }, UI_TIMEOUT_MS, 0, isCancelled);
    if (!catalog) return;

    modelCatalog = catalog;
    try {
      if (JSON.stringify(stored[core.MODEL_CATALOG_KEY]) !== JSON.stringify(catalog)) {
        await chrome.storage.local.set({ [core.MODEL_CATALOG_KEY]: catalog });
      }
    } catch {
      // Кэш помогает popup, но не нужен для работы с уже прочитанным меню.
    }
  }

  function isModelOptionEnabled(item) {
    if (!isControlEnabled(item) || item.hasAttribute("disabled") ||
        item.querySelector('[aria-disabled="true"], [disabled]')) {
      return false;
    }
    // Заблокированная подпиской модель может оставаться кликабельной,
    // открывая предложение обновить тариф вместо переключения модели.
    return !getSiteModeId(item)?.startsWith("upsell_") && !Array.from(item.querySelectorAll(
      'mat-icon, [data-mat-icon-name], [fonticon]'
    )).some((icon) => isVisible(icon) && [
      icon.getAttribute("data-mat-icon-name"), icon.getAttribute("fonticon"),
      core.normalizeText(icon.textContent)
    ].some((name) => name === "lock" || name === "lock_outline"));
  }

  function findModelOption(items, model) {
    const findLiveModel = (candidate) => {
      const exact = modelCatalog.find(({ id }) => id === candidate.id);
      if (exact || !core.getModel(candidate.id)) return exact || candidate;
      const byLabel = modelCatalog.filter(({ label }) => label === candidate.label);
      return byLabel.length === 1 ? byLabel[0] : candidate;
    };
    const effectiveModel = core.resolveModelWithFallback(model.id, (candidate) => {
      return Boolean(findMenuItem(items, findLiveModel(candidate)));
    }) || model;
    const live = findLiveModel(effectiveModel);
    const item = findMenuItem(items, live);
    return item ? { item, model: live } : null;
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

  async function closeModeMenu(previousSubmenu = null, isCancelled, timeoutMs = UI_TIMEOUT_MS) {
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
      const closed = await waitFor(() => !isVisible(submenu), timeoutMs, 0, isCancelled);
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
    const closed = await waitFor(() => isModeMenuClosed(menu), timeoutMs, 0, isCancelled);
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
      isModel: isModelItem(item),
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
    const picker = findModePicker();
    if (!info || !picker || !readThinkingMenuState(info)) {
      return null;
    }
    const modelId = readPickerState(picker).model;
    if (!modelId) return null;
    if (info.kind === "legacy") {
      return { kind: "legacy", targetLevel, modelId };
    }

    // Уровень определяет позиция, а не значение подписи. Текст нужен только
    // для сверки с кнопкой после закрытия меню в рамках текущего применения.
    // Эти подписи не сохраняются в настройках или межзапусковом кэше.
    const labels = info.items.map((item) => {
      const primary = item.querySelector(".label, .mdc-list-item__primary-text");
      function readLabel(node) {
        if (node.nodeType === 3) return node.textContent || "";
        if (node.matches?.('.sublabel, .description, .mdc-list-item__secondary-text, mat-icon, svg, [role="img"]')) return "";
        return Array.from(node.childNodes || []).map(readLabel).join(" ");
      }
      return core.normalizeText(primary?.textContent || item.getAttribute("aria-label") || readLabel(item));
    });
    const targetLabel = labels[core.THINKING_LEVELS.indexOf(targetLevel)];
    return {
      kind: "levels",
      modelId,
      targetLevel,
      submenu: findThinkingSubmenu(),
      targetLabel: targetLabel && labels.filter((label) => label === targetLabel).length === 1
        ? targetLabel : null
    };
  }

  function matchesThinkingConfirmation(confirmation) {
    const picker = findModePicker();
    if (!confirmation || !picker || readPickerState(picker).model !== confirmation.modelId) {
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
        (modelId === "auto" || matchesThinkingConfirmation(confirmation));
    }, timeoutMs, STATE_STABLE_MS, isCancelled);
  }

  async function selectModel(modelId, targetLevel, timeoutMs = UI_TIMEOUT_MS, isCancelled) {
    const model = modelCatalog.find(({ id }) => id === modelId) || core.getModel(modelId);
    if (!model) {
      throw Object.assign(new Error("Your saved model is unavailable in this Gemini menu."), {
        retryable: false
      });
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
          throw Object.assign(new Error(
            `${unavailable.model.label} is unavailable for this account. Choose another model.`
          ), { retryable: false });
        }
        throw Object.assign(new Error(`Could not find the ${model.label} model option.`), { retryable: false });
      }
      const effectiveModel = selection.model;

      // Если уровни уже видны, их подписи помогают избежать лишнего открытия.
      // Их наличие у старой модели не должно блокировать выбор новой модели.
      const thinkingConfirmation = effectiveModel.id === "auto" ? null :
        createThinkingConfirmation(getVisibleThinkingMenuInfo(), targetLevel);
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
          throw Object.assign(new Error(
            `${effectiveModel.label} is unavailable for this account. Choose another model.`
          ), { retryable: false });
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
        await closeModeMenu(thinkingConfirmation?.submenu, isCancelled, timeoutMs);
        // Подписи и выбранный уровень прежней модели больше ничего не подтверждают.
        return { modelId: effectiveModel.id, changed: true, thinkingConfirmation: null };
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
      const info = getVisibleThinkingMenuInfo();
      const confirmation = createThinkingConfirmation(info, targetLevel);
      const targetItem = info?.items[info.kind === "legacy" ? 0 : core.THINKING_LEVELS.indexOf(targetLevel)];
      const unavailable = confirmation && targetItem && !isControlEnabled(targetItem);
      const ambiguous = confirmation?.kind === "levels" && !confirmation.targetLabel;
      throw Object.assign(new Error("The requested thinking level is not available or could not be verified."), {
        retryable: !unavailable && !ambiguous
      });
    }
    ensureApplicationActive(isCancelled);
    if (!ready.selected) {
      ready.targetItem.click();
      // Не посылаем Escape, пока Gemini ещё обрабатывает выбор. Сверяем живое
      // состояние меню или бейдж после естественного закрытия, а не старый DOM-пункт.
      const committed = await waitFor(() => matchesThinkingConfirmation(ready.confirmation),
        timeoutMs, 0, isCancelled);
      if (!committed) throw new Error("Gemini did not confirm the requested thinking level.");
    }
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
    let thinkingConfirmation = null;
    let failed = true;

    try {
      if (chrome.storage.local && (!modelCatalog.length || (!core.getModel(targetSettings.model) &&
          !modelCatalog.some(({ id }) => id === targetSettings.model)))) {
        await refreshModelCatalog(timeoutMs, options.isCancelled);
      }
      const loadedPicker = findModePicker();
      const requestedModel = core.resolveCatalogModel(
        modelCatalog, targetSettings.model, loadedPicker && readPickerState(loadedPicker).model
      );
      let effectiveModelId = requestedModel;
      for (let attempt = 0; attempt < MAX_INTERACTION_ATTEMPTS; attempt += 1) {
        try {
          const currentPicker = findModePicker();
          ensureApplicationActive(options.isCancelled);
          if (!currentPicker || readPickerState(currentPicker).model !== effectiveModelId) {
            const selectionResult = await selectModel(
              requestedModel, targetSettings.thinkingLevel, timeoutMs, options.isCancelled
            );
            effectiveModelId = selectionResult.modelId;
            changed ||= selectionResult.changed;
            thinkingConfirmation = selectionResult.thinkingConfirmation;
          }

          if (effectiveModelId !== "auto" && !matchesThinkingConfirmation(thinkingConfirmation)) {
            const thinkingResult = await setThinkingLevel(
              targetSettings.thinkingLevel, timeoutMs, options.isCancelled
            );
            changed ||= thinkingResult.changed;
            thinkingConfirmation = thinkingResult.confirmation;
          }
          ensureApplicationActive(options.isCancelled);
          await closeModeMenu(thinkingConfirmation?.submenu, options.isCancelled, timeoutMs);
          if (await waitForStableSettings(thinkingConfirmation, effectiveModelId, timeoutMs, options.isCancelled)) {
            failed = false;
            options.onConfirmed?.(thinkingConfirmation);
            if (options.initialApplication && options.applyId === latestApplyId) {
              watchForStartupReset(targetSettings, thinkingConfirmation, effectiveModelId, requestedModel);
            }
            return { applied: true, changed };
          }
          throw new Error("Gemini did not confirm the final model settings.");
        } catch (error) {
          if (options.isCancelled?.() || error.retryable === false ||
              attempt === MAX_INTERACTION_ATTEMPTS - 1) throw error;
          // После перерисовки заново находим все элементы и подтверждаем оба значения.
          try {
            await closeModeMenu(thinkingConfirmation?.submenu, options.isCancelled, timeoutMs);
          } catch {
            // Следующая попытка проверит живое меню; сохраняем исходную причину сбоя.
          }
          thinkingConfirmation = null;
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
      throw new Error("Gemini did not confirm the final model settings.");
    } catch (error) {
      if (options.isCancelled?.()) return { applied: false, cancelled: true, reason: error.message };
      throw error;
    } finally {
      if (!options.isCancelled?.() && (findModePicker()?.getAttribute("aria-expanded") === "true" ||
          (thinkingConfirmation?.submenu && isVisible(thinkingConfirmation.submenu)))) {
        try {
          await closeModeMenu(thinkingConfirmation?.submenu, options.isCancelled, timeoutMs);
        } catch (error) {
          if (!failed) throw error;
        }
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

  function watchForStartupReset(settings, confirmation, modelId, requestedModel) {
    stopStartupResetWatch();
    let cancelled = false;
    let recovering = false;
    let expired = false;
    let recoveryCount = 0;
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
      if (!event.isTrusted) return;
      // Фокусировка поля сама по себе не меняет настройки. Печатать при открывающемся
      // меню небезопасно, поэтому keydown/input по-прежнему отменяют восстановление.
      if (event.type === "pointerdown" && findPromptEditor()?.contains(event.target)) return;
      cancel();
    }

    function needsRecovery() {
      const picker = findModePicker();
      return isControlEnabled(picker) && isModeMenuClosed() &&
        (readPickerState(picker).model !== modelId ||
          (modelId !== "auto" && !matchesThinkingConfirmation(confirmation)));
    }

    function check() {
      if (cancelled || expired || recovering) return;
      if (!needsRecovery()) {
        clearTimeout(mismatchTimer);
        mismatchTimer = null;
      } else if (mismatchTimer === null) {
        mismatchTimer = setTimeout(recover, STATE_STABLE_MS);
      }
    }

    function recover() {
      mismatchTimer = null;
      if (cancelled || expired || !needsRecovery()) return;
      recovering = true;
      recoveryCount++;
      // Gemini может закончить загрузку или сбросить thinking уже после
      // успешной проверки. Разрешаем два восстановления в исходном окне,
      // без вечного автопереключения и продления окна после каждого сброса.
      const request = enqueueApply({
        settings: requestedModel === settings.model ? settings : { ...settings, model: requestedModel },
        timeoutMs: COLD_START_UI_TIMEOUT_MS, isCancelled: () => cancelled,
        onConfirmed: (nextConfirmation) => { confirmation = nextConfirmation; }
      });
      if (initialApplicationSettings === settings) initialApplicationRequest = request;
      request.catch((error) => {
        console.debug("[Gemini Default Model Selector]", error.message);
      }).finally(() => {
        recovering = false;
        if (cancelled || expired || recoveryCount >= MAX_STARTUP_RECOVERIES) cleanup();
        else check();
      });
    }

    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, characterData: true
    });
    for (const type of interactionEvents) {
      document.addEventListener(type, onInteraction, true);
    }
    expiryTimer = setTimeout(() => {
      expired = true;
      observer.disconnect();
      clearTimeout(mismatchTimer);
      // Уже начатое восстановление может ждать UI дольше окна наблюдения.
      // До его завершения сохраняем возможность отменить его ручным вводом.
      if (!recovering) cleanup();
    }, STARTUP_RESET_WINDOW_MS);
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

  if (chrome.storage.local) {
    // Обновляем каталог и при ручном открытии, если Gemini дозагрузил
    // пункты после старта или вкладка осталась открытой во время обновления.
    let manualRefresh = 0;
    document.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      const picker = findModePicker();
      if (!picker?.contains(event.target)) return;
      const sequence = ++manualRefresh;
      if (picker.getAttribute("aria-expanded") === "true") return;
      refreshModelCatalog(UI_TIMEOUT_MS, () => sequence !== manualRefresh, false).catch(() => {});
    }, true);
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
    if (message?.type === core.READ_MODEL_CATALOG_MESSAGE) {
      const picker = findModePicker();
      sendResponse({ catalog: modelCatalog, currentModel: picker && readPickerState(picker).model });
      return false;
    }

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
