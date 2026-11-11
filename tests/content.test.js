const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const sharedSource = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf8");
const contentSource = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
const contentStyles = manifest.content_scripts.flatMap((entry) => entry.css || [])
  .map((file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8"));

function loadContent(options = {}) {
  let now = 0;
  let nextTimerId = 0;
  const timers = new Map();
  const clicks = [];
  const clickTimes = [];
  const focusTimes = [];
  const keyboardEvents = [];
  const errors = [];
  let messageListener;
  let storageListener;
  let observer;
  const observers = [];
  const documentListeners = new Map();
  let storageCallback;
  let initialComplete = false;
  let model = options.initialModel || "flash-3.8";
  let level = options.initialLevel || "low";
  let menuOpen = false;
  let menuOpenings = 0;
  let visibleMenuOpenings = 0;
  let menu;
  let submenu;
  let submenuTrigger;
  const levels = ["low", "medium", "high"];
  let labels = options.labels || ["Низкая", "Средний", "Высокая"];
  const stored = options.stored || { model: "flash-3.8", thinkingLevel: "high" };
  const modelLabels = {
    "flash-lite-3.5": "3.5 Flash-Lite",
    "flash-3.8": "3.8 Flash",
    "flash-3.7": "3.7 Flash",
    "pro-3.1": "3.1 Pro",
    "argon-4": "4 Argon",
    "carbon-4": "4 Carbon"
  };
  const modelDescriptions = {
    "flash-lite-3.5": "Quick answers",
    "flash-3.8": "All-around help",
    "flash-3.7": "All-around help",
    "pro-3.1": "Detailed research",
    "argon-4": "Code & analysis",
    "carbon-4": "Most complex work"
  };

  function setTimer(callback, ms) {
    timers.set(++nextTimerId, { callback, due: now + ms });
    return nextTimerId;
  }

  function recordClick(value) {
    clicks.push(value);
    clickTimes.push({ value, time: now });
  }

  function notifyObservers() {
    if (options.noMutationNotifications) return;
    for (const currentObserver of observers) {
      if (currentObserver.observing && !currentObserver.queued) {
        currentObserver.queued = true;
        queueMicrotask(() => {
          currentObserver.queued = false;
          if (currentObserver.observing) currentObserver.callback();
        });
      }
    }
  }

  class Element {
    constructor(tag, attrs = {}, text = "") {
      this.tagName = tag.toUpperCase();
      this.attrs = attrs;
      this.text = text;
      this.children = [];
      this.parentElement = null;
      this.classes = new Set();
      this.classList = { contains: (name) => this.classes.has(name) };
      this.hidden = false;
      this.checked = false;
    }
    append(child) { child.parentElement = this; this.children.push(child); return child; }
    get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
    set textContent(value) { this.text = value; this.children = []; }
    get isConnected() { return this === document || Boolean(this.parentElement?.isConnected); }
    get previousElementSibling() {
      const siblings = this.parentElement?.children || [];
      return siblings[siblings.indexOf(this) - 1] || null;
    }
    getAttribute(name) { return this.attrs[name] ?? null; }
    hasAttribute(name) { return name in this.attrs; }
    setAttribute(name, value) { this.attrs[name] = value; }
    removeAttribute(name) { delete this.attrs[name]; }
    contains(element) { return element === this || this.children.some((child) => child.contains(element)); }
    getClientRects() {
      return this.isConnected && !this.hidden && (!this.parentElement || this.parentElement.getClientRects().length)
        ? [{}] : [];
    }
    matches(selector) {
      return selector.split(",").some((part) => {
        part = part.trim();
        let depth = 0;
        for (let i = 0; i < part.length; i++) {
          if (part[i] === "[") depth++;
          else if (part[i] === "]") depth--;
          else if (/\s/.test(part[i]) && depth === 0) {
            if (!this.matches(part.slice(i + 1).trim())) return false;
            for (let parent = this.parentElement; parent; parent = parent.parentElement) {
              if (parent.matches(part.slice(0, i))) return true;
            }
            return false;
          }
        }
        const tag = part.match(/^[\w-]+/);
        if (tag && tag[0].toUpperCase() !== this.tagName) return false;
        const id = part.match(/#([\w-]+)/);
        if (id && this.getAttribute("id") !== id[1]) return false;
        const attributes = [...part.matchAll(/\[([\w-]+)(?:(\*=|=)"([^"]*)"(?:\s+(i))?)?\]/g)];
        if (attributes.some(([, name, operator, expected, insensitive]) => {
          let actual = this.getAttribute(name);
          if (actual === null) return true;
          if (!operator) return false;
          if (insensitive) { actual = actual.toLowerCase(); expected = expected.toLowerCase(); }
          return operator === "=" ? actual !== expected : !actual.includes(expected);
        })) return false;
        const withoutAttributes = part.replace(/\[[^\]]*\]/g, "");
        return [...withoutAttributes.matchAll(/\.([\w-]+)/g)].every(([, name]) => this.classes.has(name));
      });
    }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [
        ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)
      ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    dispatchEvent(event) {
      if (event.type === "mouseenter") this.onMouseEnter?.();
      if (event.type !== "keydown") return true;
      keyboardEvents.push({ type: event.type, key: event.key, keyCode: event.keyCode,
        bubbles: event.bubbles, time: now });
      if (submenu?.contains(this) && event.key === "Escape" && options.submenuEscapeOnly) {
        closeSubmenu(true);
        return true;
      }
      if (menuOpen && event.type === "keydown" && event.key === "Escape" &&
        event.keyCode === 27 && event.bubbles && !options.ignoreEscape) closeMenu(true);
      return true;
    }
    click() { this.onClick?.(); }
    focus() {
      document.activeElement = this;
      focusTimes.push({ target: this.tagName, time: now,
        menuVisible: Boolean(menu?.isConnected && !menu.hidden) });
    }
    remove() {
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
        this.parentElement = null;
      }
    }
  }
  class TextArea extends Element {
    constructor(value = "draft") { super("textarea", { "aria-label": "prompt" }); this.value = value; }
    setSelectionRange(start, end) { this.selection = [start, end]; }
  }
  class TextNode {
    constructor(text) { this.textContent = text; this.parentElement = null; }
    get isConnected() { return Boolean(this.parentElement?.isConnected); }
    getClientRects() { return this.isConnected ? [{}] : []; }
    contains(node) { return node === this; }
    matches() { return false; }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    getAttribute() { return null; }
    hasAttribute() { return false; }
  }
  class MockRange {
    setStart(node, offset) { this.startContainer = node; this.startOffset = offset; }
    setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; }
    selectNodeContents(node) {
      const textNode = node.children.find((child) => child instanceof TextNode);
      this.setStart(node, 0);
      this.setEnd(textNode || node, textNode ? textNode.textContent.length : node.children.length);
    }
    collapse(toStart = false) {
      if (toStart) this.setEnd(this.startContainer, this.startOffset);
      else this.setStart(this.endContainer, this.endOffset);
    }
    cloneRange() {
      const clone = new MockRange();
      clone.setStart(this.startContainer, this.startOffset);
      clone.setEnd(this.endContainer, this.endOffset);
      return clone;
    }
  }
  class MockSelection {
    constructor() { this.ranges = []; }
    get rangeCount() { return this.ranges.length; }
    get anchorNode() { return this.ranges[0]?.startContainer || null; }
    get anchorOffset() { return this.ranges[0]?.startOffset || 0; }
    getRangeAt(index) { return this.ranges[index]; }
    removeAllRanges() { this.ranges = []; }
    addRange(range) { this.ranges = [range]; }
    collapse(node, offset) {
      const range = new MockRange();
      range.setStart(node, offset);
      range.setEnd(node, offset);
      this.addRange(range);
    }
  }
  class ContentEditable extends Element {
    constructor(value = "draft") {
      super("div", { role: "textbox", contenteditable: "true", "aria-label": "prompt" });
      this.isContentEditable = true;
      this.textNode = this.append(new TextNode(value));
    }
  }
  const document = new Element("document");
  document.documentElement = document;
  document.addEventListener = (type, listener) => {
    if (!documentListeners.has(type)) documentListeners.set(type, new Set());
    documentListeners.get(type).add(listener);
  };
  document.removeEventListener = (type, listener) => documentListeners.get(type)?.delete(listener);
  function interact(type = "pointerdown", isTrusted = true) {
    for (const listener of documentListeners.get(type) || []) listener({ type, isTrusted });
  }
  document.hidden = Boolean(options.backgroundTab);
  // Document.hidden describes the tab's visibility; its DOM still has layout.
  document.getClientRects = () => [{}];
  document.head = document.append(new Element("head"));
  document.createElement = (tag) => new Element(tag);
  for (const css of contentStyles) document.head.append(new Element("style", {}, css));
  const selection = new MockSelection();
  document.getSelection = () => selection;
  document.createRange = () => new MockRange();
  document.getElementById = (id) => document.querySelectorAll("*").find((element) => element.attrs.id === id) || null;
  if (options.profileMenu) document.append(new Element("button", { "aria-haspopup": "menu" }, "Profile"));
  let picker = document.append(new Element("button", {
    "aria-haspopup": "true", "aria-expanded": "false", "aria-controls": "mode-menu"
  }));
  picker.classes.add("input-area-switch");
  if (options.pickerReadyAfter) {
    picker.hidden = true;
    setTimer(() => { picker.hidden = false; notifyObservers(); }, options.pickerReadyAfter);
  }
  if (options.pickerEnabledAfter) {
    picker.disabled = true;
    setTimer(() => { picker.disabled = false; notifyObservers(); }, options.pickerEnabledAfter);
  }
  if (options.pickerAriaLabel) picker.attrs["aria-label"] = options.pickerAriaLabel;
  function createEditor(text = options.editorText || "draft") {
    return options.editorType === "contenteditable"
      ? new ContentEditable(text) : new TextArea(text);
  }
  let editor = document.append(createEditor());
  function setEditorCaret(offset) {
    if (editor instanceof TextArea) {
      editor.setSelectionRange(offset, offset);
    } else {
      selection.collapse(editor.textNode, offset);
    }
  }
  if (options.initialCaret !== undefined) setEditorCaret(options.initialCaret);
  if (options.editorReadyAfter) {
    const blockedBy = options.editorBlockedBy || "disabled";
    if (blockedBy.startsWith("aria-")) editor.attrs[blockedBy] = "true";
    else editor[blockedBy] = true;
    setTimer(() => {
      if (blockedBy.startsWith("aria-")) editor.attrs[blockedBy] = "false";
      else editor[blockedBy] = false;
      notifyObservers();
    }, options.editorReadyAfter);
  }
  document.activeElement = options.editorFocused === false ? null : editor;
  if (options.editorType === "contenteditable" && options.initialCaret === undefined) {
    setEditorCaret(editor.textNode.textContent.length);
  }
  function typeEditor(text) {
    if (editor instanceof TextArea) {
      const offset = editor.selection?.[1] ?? editor.value.length;
      editor.value = `${editor.value.slice(0, offset)}${text}${editor.value.slice(offset)}`;
      editor.setSelectionRange(offset + text.length, offset + text.length);
    } else {
      const offset = selection.anchorNode === editor.textNode
        ? selection.anchorOffset : editor.textNode.textContent.length;
      editor.textNode.textContent = `${editor.textNode.textContent.slice(0, offset)}${text}${editor.textNode.textContent.slice(offset)}`;
      setEditorCaret(offset + text.length);
    }
    notifyObservers();
  }
  function rerenderEditor() {
    const previous = editor;
    const text = editor instanceof TextArea ? editor.value : editor.textContent;
    if (document.activeElement === previous) document.activeElement = null;
    previous.remove();
    editor = document.append(createEditor(text));
    if (editor instanceof ContentEditable) setEditorCaret(editor.textNode.textContent.length);
    notifyObservers();
  }

  function computedStyle(element) {
    const style = { display: element.hidden ? "none" : "block", visibility: "visible", opacity: "1" };
    for (const sheet of document.querySelectorAll("style")) {
      for (const [, selectors, declarations] of sheet.textContent.matchAll(/([^{}]+)\{([^}]+)\}/g)) {
        if (element.matches(selectors)) {
          for (const declaration of declarations.split(";")) {
            const [property, value] = declaration.split(":").map((part) => part?.trim());
            if (property && value) style[property] = value.replace(/\s*!important$/, "");
          }
        }
      }
    }
    return style;
  }

  function refreshPicker() {
    picker.text = options.shortPickerLabels
      ? modelLabels[model].replace(/^[\d.]+ /, "") : modelLabels[model];
    picker.children = [];
    if (level !== "low" || options.lowBadge) {
      const badge = picker.append(new Element("span", {}, labels[levels.indexOf(level)]));
      badge.classes.add("picker-secondary-text");
    }
    notifyObservers();
  }
  function closeMenu(animate = false) {
    menuOpen = false;
    picker.attrs["aria-expanded"] = "false";
    closeSubmenu(animate);
    if (menu) {
      const closingMenu = menu;
      const closingPanel = closingMenu.closest(".cdk-overlay-pane");
      const removeMenu = () => { (closingPanel || closingMenu).remove(); notifyObservers(); };
      if (animate && options.menuCloseDelay) setTimer(removeMenu, options.menuCloseDelay);
      else removeMenu();
    }
    notifyObservers();
  }
  function closeSubmenu(animate = false) {
    if (submenuTrigger) submenuTrigger.attrs["aria-expanded"] = "false";
    if (!submenu?.isConnected) return;
    const closing = submenu;
    const remove = () => { closing.remove(); notifyObservers(); };
    if (animate && options.submenuCloseDelay) setTimer(remove, options.submenuCloseDelay);
    else remove();
    notifyObservers();
  }
  function markSelected(item, selected) {
    if (options.indicator === "aria") item.attrs["aria-checked"] = String(selected);
    else if (options.indicator === "icon" && selected) {
      item.append(new Element("mat-icon", { "data-mat-icon-name": "check" }));
    } else if (selected) item.classes.add("selected");
  }
  function renderMenu() {
    closeMenu();
    menuOpen = true;
    picker.attrs["aria-expanded"] = "true";
    menu = document.append(new Element("gem-menu", {
      id: "mode-menu", role: "menu", "data-test-id": "gem-mode-menu"
    }));
    if (options.noMenuTestId) delete menu.attrs["data-test-id"];
    for (const id of options.availableModels || ["flash-lite-3.5", "flash-3.8", "pro-3.1", "argon-4"]) {
      const item = menu.append(new Element("gem-menu-item", { role: "menuitem",
        ...(options.noModelIds ? {} : { "data-mode-id": id }) }, options.descriptionFirst ? "" : modelLabels[id]));
      if (options.descriptionFirst) {
        item.append(new Element("span", {}, modelDescriptions[id])).classes.add("label");
        item.append(new Element("span", {}, modelLabels[id])).classes.add("sublabel");
      }
      if (options.disabledModel === id) {
        if (options.modelBlocker === "disabled") {
          item.disabled = true;
          item.attrs.disabled = "";
        } else if (options.modelBlocker === "nested-disabled") {
          item.append(new Element("button", { disabled: "" }));
        } else if (options.modelBlocker === "lock-icon") {
          item.append(new Element("mat-icon", { "data-mat-icon-name": "lock" }));
        } else if (options.modelBlocker === "lock-text") {
          item.append(new Element("mat-icon", {}, "lock"));
        } else if (options.modelBlocker === "lock-fonticon") {
          item.append(new Element("mat-icon", { fonticon: "lock_outline" }));
        } else item.attrs["aria-disabled"] = "true";
        if (options.enableModelAfter) {
          setTimer(() => { delete item.attrs["aria-disabled"]; notifyObservers(); }, options.enableModelAfter);
        }
      }
      markSelected(item, model === id);
      item.onClick = () => {
        recordClick(id);
        closeMenu(true);
        const update = () => {
          if (!options.ignoreModelClicks) model = id;
          if (options.resetThinkingOnModelChange) level = "low";
          refreshPicker();
          if (options.delayedThinkingReset) {
            setTimer(() => { level = "low"; refreshPicker(); }, options.delayedThinkingReset);
          }
          if (options.modelDriftAfterClick) {
            setTimer(() => { model = options.initialModel; refreshPicker(); }, options.modelDriftAfterClick);
          }
        };
        if (options.modelClickDelay) setTimer(update, options.modelClickDelay);
        else update();
      };
    }
    if (options.separator !== false) menu.append(new Element("mat-divider", { role: "separator" }));
    if (options.modelsWithoutThinking?.includes(model)) {
      notifyObservers();
      return;
    }
    if (options.nestedThinking) {
      const attributes = { id: "thinking-trigger", role: "menuitem",
        "aria-haspopup": "menu", "aria-expanded": "false" };
      if (options.submenuLink !== "labelledby" && options.submenuLink !== "nested") {
        attributes[options.submenuLink === "owns" ? "aria-owns" : "aria-controls"] = "thinking-menu";
      }
      submenuTrigger = menu.append(new Element("gem-menu-item", attributes, "Глубина мышления"));
      const openSubmenu = () => {
        submenuTrigger.attrs["aria-expanded"] = "true";
        const show = () => {
          if (!menuOpen) return;
          submenu = (options.submenuLink === "nested" ? submenuTrigger : document)
            .append(new Element("gem-menu", { id: "thinking-menu", role: "menu",
              ...(options.submenuLink === "labelledby" ? { "aria-labelledby": "thinking-trigger" } : {}) }));
          renderThinkingItems(submenu);
          notifyObservers();
        };
        if (options.submenuDelay) setTimer(show, options.submenuDelay);
        else show();
      };
      submenuTrigger.onClick = () => {
        recordClick("thinking-submenu");
        if (!options.ignoreSubmenuClicks && !options.hoverOnlySubmenu) openSubmenu();
      };
      submenuTrigger.onMouseEnter = () => {
        if (options.hoverOnlySubmenu) { recordClick("thinking-hover"); openSubmenu(); }
      };
    } else renderThinkingItems(menu);
    if (options.extraLegacyToggle) {
      const legacy = menu.append(new Element("gem-menu-item", { role: "menuitemcheckbox" }, "Old"));
      legacy.onClick = () => { clicks.push("unexpected-legacy"); };
    }
    notifyObservers();
  }
  function renderThinkingItems(container) {
    const menuLevels = options.legacy ? ["high"] : levels.slice(0, options.levelCount ?? 3);
    for (const itemLevel of menuLevels) {
      const nativeRadio = options.role === "native";
      const role = options.legacy ? "menuitemcheckbox" : options.role || "menuitem";
      const item = container.append(new Element(nativeRadio ? "input" : "gem-menu-item",
        nativeRadio ? { type: "radio" } : { role }));
      const label = item.append(new Element("span", {}, ` ${labels[levels.indexOf(itemLevel)]} `));
      label.classes.add("label");
      if (options.descriptions) {
        const description = item.append(new Element("div", {}, `Description ${itemLevel}`));
        description.classes.add("sublabel");
      }
      item.checked = level === itemLevel;
      if (options.disabledLevel === itemLevel) item.attrs["aria-disabled"] = "true";
      if (!options.noSelectionIndicator) {
        if (options.selectionDelay) {
          setTimer(() => {
            if (item.isConnected) markSelected(item, level === itemLevel);
            notifyObservers();
          }, options.selectionDelay);
        } else markSelected(item, level === itemLevel);
      }
      if (options.enableLevelAfter && options.disabledLevel === itemLevel) {
        setTimer(() => { item.attrs["aria-disabled"] = "false"; notifyObservers(); }, options.enableLevelAfter);
      }
      if (options.multipleSelected) item.classes.add("selected");
      // Keyboard focus is independent of the persistent selected state in Gemini.
      if (itemLevel === "low") item.classes.add("active");
      item.onClick = () => {
        recordClick(itemLevel);
        if (!options.keepMenuOpen) closeMenu(true);
        setTimer(() => {
          if (!options.ignoreClicks) {
            level = options.legacy ? (level === "low" ? "high" : "low") : options.redirectLevel || itemLevel;
          }
          refreshPicker();
          if (menuOpen) renderMenu();
          if (options.driftAfterClick) {
            setTimer(() => {
              level = options.driftAfterClick;
              refreshPicker();
              if (menuOpen) renderMenu();
            }, options.driftDelay ?? 300);
          }
        }, options.clickDelay ?? 100);
      };
    }
  }
  picker.onClick = () => {
    recordClick("picker");
    picker.focus();
    if (menuOpen) {
      if (!options.pickerClickDoesNotClose) closeMenu(true);
    }
    else {
      menuOpenings++;
      const showMenu = () => {
        renderMenu();
        if (computedStyle(menu).opacity !== "0") visibleMenuOpenings++;
      };
      if (options.menuDelay) {
        menuOpen = true;
        picker.attrs["aria-expanded"] = "true";
        notifyObservers();
        setTimer(showMenu, options.menuDelay);
      } else showMenu();
    }
  };
  refreshPicker();
  if (options.noControls) delete picker.attrs["aria-controls"];
  if (options.unrelatedMenu) {
    const other = document.append(new Element("div", { role: "menu" }));
    for (let i = 0; i < 3; i++) {
      const item = other.append(new Element("button", { role: "menuitemradio", "aria-checked": String(i === 0) }, `Other ${i}`));
      item.onClick = () => { clicks.push("unexpected-menu"); };
    }
  }

  class ClockDate extends Date { static now() { return now; } }
  class KeyEvent {
    constructor(type, init) { this.type = type; Object.assign(this, init); }
  }
  class Observer {
    constructor(callback) { this.callback = callback; if (!observer) observer = this; observers.push(this); }
    observe() { this.observing = true; }
    disconnect() { if (this === observer) initialComplete = true; this.observing = false; }
  }
  const chrome = {
    storage: {
      sync: { get(keys, callback) {
        storageCallback = () => callback(Object.fromEntries(
          keys.filter((key) => key in stored).map((key) => [key, stored[key]])
        ));
        if (!options.deferStorage) storageCallback();
      } },
      onChanged: { addListener(listener) { storageListener = listener; } }
    },
    runtime: { onMessage: { addListener(listener) { messageListener = listener; } } }
  };
  const context = vm.createContext({
    document, chrome, HTMLElement: Element, HTMLTextAreaElement: TextArea,
    KeyboardEvent: KeyEvent, MouseEvent: KeyEvent,
    MutationObserver: Observer, Date: ClockDate,
    setTimeout: setTimer, clearTimeout: (id) => timers.delete(id),
    getComputedStyle: computedStyle,
    console: { debug: (...args) => errors.push(args.join(" ")) }
  });
  vm.runInContext(sharedSource, context);
  vm.runInContext(contentSource, context);

  async function runUntil(done) {
    for (let step = 0; step < 2000; step++) {
      await new Promise(setImmediate);
      if (done()) return;
      const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
      assert(next, "content script stopped without completing the operation");
      timers.delete(next[0]);
      now = next[1].due;
      next[1].callback();
    }
    assert.fail("content script exceeded the timer budget");
  }
  return {
    clicks, clickTimes, focusTimes, keyboardEvents, errors,
    get editor() { return editor; },
    get picker() { return picker; },
    document, computedStyle,
    clock: () => now,
    pendingTimers: () => timers.size,
    activeObservers: () => observers.filter((entry) => entry.observing).length,
    notifyObservers,
    schedule: setTimer,
    setEditorCaret,
    typeEditor,
    rerenderEditor,
    state: () => ({ model, level, menuOpen }),
    openings: () => ({ total: menuOpenings, visible: visibleMenuOpenings }),
    async start() {
      await runUntil(() => initialComplete && observers.every((entry) => !entry.observing));
    },
    send(settings, messageOptions = {}) {
      let response;
      assert.equal(messageListener({ type: "GEMINI_DEFAULT_MODEL_APPLY", settings, focusComposer: false,
        ...messageOptions }, {},
        (result) => { response = JSON.parse(JSON.stringify(result)); }), true);
      return { done: () => response !== undefined, response: () => response };
    },
    async apply(settings) {
      const request = this.send(settings);
      await runUntil(request.done);
      return request.response();
    },
    changeStorage(changes) { storageListener(changes, "sync"); },
    finishStorage: () => storageCallback(),
    interact,
    documentListenerCount: () => [...documentListeners.values()].reduce((sum, listeners) => sum + listeners.size, 0),
    setLevel(value) { level = value; refreshPicker(); },
    setModel(value) { model = value; refreshPicker(); },
    replacePicker(value = model, thinkingLevel = level) {
      const oldPicker = picker;
      picker = new Element("button", { ...oldPicker.attrs });
      picker.classes.add("input-area-switch");
      picker.onClick = oldPicker.onClick;
      oldPicker.remove();
      document.append(picker);
      model = value;
      level = thinkingLevel;
      refreshPicker();
    },
    setLabels(value) { labels = value; refreshPicker(); },
    runUntil
  };
}

test("cold start selects high from Russian medium without a translation dictionary", async () => {
  const page = loadContent({ initialLevel: "medium", profileMenu: true });
  await page.start();
  assert.equal(page.state().level, "high");
  assert.deepEqual(page.errors, []);
  assert(page.clicks.includes("high"));
  assert.equal(page.state().menuOpen, false);
  assert.equal(page.document.activeElement, page.editor);
  assert.equal(page.editor.value, "draft");
  assert.deepEqual(page.editor.selection, [page.editor.value.length, page.editor.value.length]);
});

for (const initialCaret of [0, 3]) {
  test(`contenteditable restores the caret to the end when it started at ${initialCaret}`, async () => {
    const page = loadContent({ editorType: "contenteditable", editorText: "draft text",
      initialCaret });
    await page.start();
    assert.deepEqual(page.errors, []);
    assert.equal(page.editor.textContent, "draft text");
    assert.equal(page.document.activeElement, page.editor);
    assert.equal(page.document.getSelection().anchorNode, page.editor.textNode);
    assert.equal(page.document.getSelection().anchorOffset, page.editor.textNode.textContent.length);
  });
}

test("contenteditable typing before a model change is preserved and leaves the caret at the end", async () => {
  const page = loadContent({ editorType: "contenteditable", editorText: "draft text" });
  await page.start();
  page.setEditorCaret(2);
  page.typeEditor(" added");
  const typedText = page.editor.textContent;

  const result = await page.apply({ model: "argon-4", thinkingLevel: "high" });

  assert.equal(result.ok, true);
  assert.equal(page.editor.textContent, typedText);
  assert.equal(page.document.activeElement, page.editor);
  assert.equal(page.document.getSelection().anchorNode, page.editor.textNode);
  assert.equal(page.document.getSelection().anchorOffset, typedText.length);
});

test("contenteditable typing during verification is preserved and moves the caret to the current end", async () => {
  const page = loadContent({ editorType: "contenteditable", editorText: "draft text",
    initialCaret: 1, clickDelay: 0 });
  page.schedule(() => page.typeEditor(" typed while waiting"), 50);
  await page.start();

  assert.deepEqual(page.errors, []);
  assert.equal(page.editor.textContent, "d typed while waitingraft text");
  assert.equal(page.document.activeElement, page.editor);
  assert.equal(page.document.getSelection().anchorNode, page.editor.textNode);
  assert.equal(page.document.getSelection().anchorOffset, page.editor.textNode.textContent.length);
});

test("contenteditable restores focus and caret to the latest editor after it rerenders", async () => {
  const page = loadContent({ editorType: "contenteditable", editorText: "draft text",
    initialModel: "pro-3.1", initialLevel: "low", modelClickDelay: 100,
    stored: { model: "flash-3.8", thinkingLevel: "high" } });
  const originalEditor = page.editor;
  page.schedule(() => {
    page.typeEditor(" + current text");
    page.rerenderEditor();
  }, 50);
  await page.start();

  assert.deepEqual(page.errors, []);
  assert.notEqual(page.editor, originalEditor);
  assert.equal(page.editor.textContent, "draft text + current text");
  assert.equal(page.document.activeElement, page.editor);
  assert.equal(page.document.getSelection().anchorNode, page.editor.textNode);
  assert.equal(page.document.getSelection().anchorOffset, page.editor.textNode.textContent.length);
});

test("startup changes the level with one visible opening and leaves manual opening visible", async () => {
  const page = loadContent({ initialLevel: "medium" });
  await page.start();
  assert.equal(page.state().level, "high");
  assert.deepEqual(page.openings(), { total: 1, visible: 1 });
  assert.equal(page.document.documentElement.hasAttribute("data-gemini-default-model-applying"), false);
  page.picker.click();
  assert.deepEqual(page.openings(), { total: 2, visible: 2 });
  page.picker.click();
});

test("a disabled level fails with one visible opening and leaves other menus untouched", async () => {
  const page = loadContent({ unrelatedMenu: true, disabledLevel: "high" });
  await page.runUntil(() => page.state().menuOpen);
  const unrelated = page.document.querySelectorAll('[role="menu"]').find((menu) => !menu.hasAttribute("data-test-id"));
  assert.equal(page.computedStyle(unrelated).opacity, "1");
  await page.start();
  assert(page.errors.length > 0);
  assert.deepEqual(page.openings(), { total: 1, visible: 1 });
  assert.equal(page.document.documentElement.hasAttribute("data-gemini-default-model-applying"), false);
  page.picker.click();
  assert.equal(page.openings().visible, 2);
  page.picker.click();
});

test("an early background request replaces the scheduled startup application", async () => {
  const page = loadContent({ initialLevel: "high" });
  const request = page.send({ thinkingLevel: "high" }, { waitForUi: true, initialApplication: true });
  await page.runUntil(request.done);
  assert.equal(request.response().ok, true);
  assert.equal(page.openings().total, 1);
  assert.equal(page.openings().visible, 1);
  assert.equal(page.state().menuOpen, false);
});

test("changes the legacy toggle with one visible opening even without a Gemini test id", async () => {
  const page = loadContent({ legacy: true, initialLevel: "low", noMenuTestId: true });
  await page.start();
  assert.equal(page.state().level, "high");
  assert.deepEqual(page.openings(), { total: 1, visible: 1 });
  assert.equal(page.document.documentElement.hasAttribute("data-gemini-default-model-applying"), false);
  page.picker.click();
  assert.equal(page.openings().visible, 2);
  page.picker.click();
});

test("a background request joins startup already applying the same settings", async () => {
  const page = loadContent({ initialLevel: "high" });
  await page.runUntil(() => page.clicks.includes("picker"));
  const request = page.send({ thinkingLevel: "high" }, { waitForUi: true, initialApplication: true });
  await page.runUntil(request.done);
  assert.equal(request.response().ok, true);
  assert.equal(page.openings().total, 1);
  assert.equal(page.openings().visible, 1);
  assert.equal(page.state().menuOpen, false);
});

test("a late new-tab background request reuses completed startup without reopening", async () => {
  const page = loadContent({ initialLevel: "medium" });
  await page.start();
  const request = page.send({ thinkingLevel: "high" }, {
    waitForUi: true, initialApplication: true, focusComposer: true
  });
  await page.runUntil(request.done);
  assert.equal(request.response().ok, true);
  assert.equal(request.response().applied, true);
  assert.equal(page.document.activeElement, page.editor);
  assert.deepEqual(page.openings(), { total: 1, visible: 1 });
});

test("a late new-tab request with different settings still applies them", async () => {
  const page = loadContent();
  await page.start();
  const request = page.send({ thinkingLevel: "medium" }, { waitForUi: true, initialApplication: true });
  await page.runUntil(request.done);
  assert.equal(request.response().ok, true);
  assert.equal(page.state().level, "medium");
  assert.deepEqual(page.openings(), { total: 2, visible: 2 });
});

test("a delayed startup signal preserves a manual selection made after successful startup", async () => {
  const page = loadContent();
  await page.start();
  page.setLevel("medium");
  const request = page.send({ thinkingLevel: "high" }, { waitForUi: true, initialApplication: true });
  await page.runUntil(request.done);
  assert.equal(request.response().ok, true);
  assert.equal(page.state().level, "medium");
  assert.deepEqual(page.openings(), { total: 1, visible: 1 });
});

test("waitForUi alone remains an explicit application after a manual selection", async () => {
  const page = loadContent();
  await page.start();
  page.setLevel("medium");
  const request = page.send({ thinkingLevel: "high" }, { waitForUi: true });
  await page.runUntil(request.done);
  assert.equal(request.response().ok, true);
  assert.equal(page.state().level, "high");
  assert.deepEqual(page.openings(), { total: 2, visible: 2 });
});

test("the completed startup result can be consumed only once", async () => {
  const page = loadContent();
  await page.start();
  const first = page.send({ thinkingLevel: "high" }, { initialApplication: true });
  await page.runUntil(first.done);
  page.setLevel("medium");
  const second = page.send({ thinkingLevel: "high" }, { initialApplication: true });
  await page.runUntil(second.done);
  assert.equal(first.response().ok, true);
  assert.equal(second.response().ok, true);
  assert.equal(page.state().level, "high");
  assert.deepEqual(page.openings(), { total: 2, visible: 2 });
});

test("a popup request after startup restores the setting after a manual change", async () => {
  const page = loadContent();
  await page.start();
  page.setLevel("medium");
  const result = await page.apply({ thinkingLevel: "high" });
  assert.equal(result.ok, true);
  assert.equal(page.state().level, "high");
  assert.deepEqual(page.openings(), { total: 2, visible: 2 });
});

test("explicit requests during startup retain order instead of joining an obsolete startup result", async () => {
  const page = loadContent({ clickDelay: 800 });
  await page.runUntil(() => page.clicks.includes("high"));
  const first = page.send({ thinkingLevel: "medium" });
  const second = page.send({ thinkingLevel: "high" });
  await page.runUntil(() => first.done() && second.done());
  assert.equal(first.response().ok, true);
  assert.equal(second.response().ok, true);
  assert.equal(page.state().level, "high");
  assert.deepEqual(page.clicks.filter((value) => value !== "picker"), ["high", "medium", "high"]);
});

test("a different explicit preference is applied after a running startup operation", async () => {
  const page = loadContent({ initialLevel: "high" });
  await page.runUntil(() => page.clicks.includes("picker"));
  const request = page.send({ thinkingLevel: "medium" });
  await page.runUntil(request.done);
  assert.equal(request.response().ok, true);
  assert.equal(page.state().level, "medium");
  assert.deepEqual(page.openings(), { total: 2, visible: 2 });
});

test("legacy disabled storage migrates to low during page startup", async () => {
  const page = loadContent({ initialLevel: "high", stored: { extendedThinking: false } });
  await page.start();
  assert.equal(page.state().level, "low");
  assert.deepEqual(page.errors, []);
});

test("legacy sync changes before startup are migrated without injected defaults", async () => {
  const page = loadContent({ initialLevel: "high", stored: { extendedThinking: true } });
  page.changeStorage({ extendedThinking: { newValue: false } });
  await page.start();
  assert.equal(page.state().level, "low");
  assert.deepEqual(page.errors, []);
});

test("legacy sync values do not override a saved new thinking level", async () => {
  const page = loadContent({ stored: { thinkingLevel: "medium" } });
  page.changeStorage({ extendedThinking: { newValue: false } });
  await page.start();
  assert.equal(page.state().level, "medium");
  assert.deepEqual(page.errors, []);
});

for (const target of ["low", "medium", "high"]) {
  test(`selects ${target} without a separator or meaningful localized labels`, async () => {
    const page = loadContent({ separator: false, labels: ["高", "α", "High"], lowBadge: true });
    await page.start();
    const result = await page.apply({ thinkingLevel: target });
    assert.equal(result.ok, true);
    assert.equal(result.applied, true);
    assert.equal(page.state().level, target);
    assert.equal(page.state().menuOpen, false);
  });
}

test("an already selected radio is not clicked or confused with keyboard focus", async () => {
  const page = loadContent({ initialLevel: "high", editorFocused: false });
  await page.start();
  assert.deepEqual(page.clicks.filter((value) => value !== "picker"), []);
  assert.notEqual(page.document.activeElement, page.editor);
});

for (const role of ["menuitemradio", "radio", "native"]) {
  test(`supports ${role} thinking options and ignores unrelated menus`, async () => {
    const page = loadContent({ role, indicator: "aria", unrelatedMenu: true, noControls: true,
      extraLegacyToggle: true, initialLevel: "medium" });
    await page.start();
    assert.equal(page.state().level, "high");
    assert.deepEqual(page.errors, []);
    assert(!page.clicks.some((value) => value.startsWith("unexpected")));
  });
}

test("confirms selection using the check icon without its localized aria-label", async () => {
  const page = loadContent({ indicator: "icon", initialLevel: "medium" });
  await page.start();
  assert.equal(page.state().level, "high");
  assert.deepEqual(page.errors, []);
});

for (const target of ["low", "medium", "high"]) {
  test(`maps ${target} to the legacy toggle only after detecting legacy UI`, async () => {
    const page = loadContent({ legacy: true, initialLevel: "high" });
    await page.start();
    const result = await page.apply({ thinkingLevel: target });
    assert.equal(result.ok, true);
    assert.equal(page.state().level, target === "low" ? "low" : "high");
  });
}

test("waits for slow UI updates without reopening the menu for verification", async () => {
  const page = loadContent({ clickDelay: 800 });
  await page.start();
  assert.equal(page.state().level, "high");
  assert.deepEqual(page.errors, []);
  assert.equal(page.clicks.filter((value) => value === "high").length, 1);
  assert.deepEqual(page.openings(), { total: 1, visible: 1 });
});

test("an immediately ready interface has only one 200 ms stability check before focus returns", async () => {
  const page = loadContent({ clickDelay: 0 });
  await page.start();
  const opened = page.clickTimes.find((event) => event.value === "picker");
  const chosen = page.clickTimes.find((event) => event.value === "high");
  const focused = page.focusTimes.find((event) => event.target === "TEXTAREA");
  assert.equal(chosen.time, opened.time);
  assert.equal(focused.time - chosen.time, 200);
  assert.equal(focused.menuVisible, false);
  assert.deepEqual(page.openings(), { total: 1, visible: 1 });
});

test("Escape closes already selected settings when the picker click cannot dismiss the menu", async () => {
  const page = loadContent({ initialLevel: "high", pickerClickDoesNotClose: true });
  await page.start();
  const opened = page.clickTimes[0];
  const closed = page.keyboardEvents[0];
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.openings(), { total: 1, visible: 1 });
  assert.deepEqual(page.clicks, ["picker"]);
  assert.equal(page.keyboardEvents.length, 1);
  assert.equal(closed.key, "Escape");
  assert.equal(closed.time, opened.time);
  assert.equal(page.focusTimes.find((entry) => entry.target === "TEXTAREA").time - opened.time, 200);
  assert.equal(page.state().menuOpen, false);
  assert.equal(page.document.activeElement, page.editor);
});

for (const legacy of [false, true]) {
  test(`Escape closes the ${legacy ? "legacy" : "three-level"} menu immediately after selection while its badge updates`, async () => {
    const page = loadContent({ legacy, keepMenuOpen: true, pickerClickDoesNotClose: true, clickDelay: 737 });
    await page.start();
    const chosen = page.clickTimes.find((event) => event.value === "high");
    const focused = page.focusTimes.find((event) => event.target === "TEXTAREA");
    assert.deepEqual(page.errors, []);
    assert.equal(page.state().level, "high");
    assert.equal(page.state().menuOpen, false);
    assert.deepEqual(page.openings(), { total: 1, visible: 1 });
    assert.deepEqual(page.clicks, ["picker", "high"]);
    assert.equal(page.keyboardEvents.length, 1);
    assert.equal(page.keyboardEvents[0].time, chosen.time);
    assert.equal(focused.time - chosen.time, 737 + 200);
  });
}

test("focus waits for the actual Escape closing animation", async () => {
  const page = loadContent({ initialLevel: "high", pickerClickDoesNotClose: true, menuCloseDelay: 87 });
  await page.start();
  assert.deepEqual(page.errors, []);
  const focused = page.focusTimes.find((event) => event.target === "TEXTAREA");
  assert.equal(focused.time - page.keyboardEvents[0].time, 87 + 200);
  assert.equal(focused.menuVisible, false);
  assert.equal(page.state().menuOpen, false);
  assert.deepEqual(page.openings(), { total: 1, visible: 1 });
  assert.equal(page.pendingTimers(), 0);
  assert.equal(page.activeObservers(), 0);
});

test("DOM changes wake verification immediately instead of waiting for the next poll", async () => {
  const page = loadContent({ clickDelay: 737 });
  await page.start();
  const chosen = page.clickTimes.find((event) => event.value === "high");
  const focused = page.focusTimes.find((event) => event.target === "TEXTAREA");
  assert.deepEqual(page.errors, []);
  assert.equal(focused.time - chosen.time, 737 + 200);
  assert.equal(page.clicks.filter((value) => value === "high").length, 1);
});

test("waits for visible options, selected state and enablement instead of a fixed opening pause", async () => {
  const page = loadContent({ menuDelay: 137, selectionDelay: 93, disabledLevel: "high",
    enableLevelAfter: 123, clickDelay: 7 });
  await page.start();
  const opened = page.clickTimes.find((event) => event.value === "picker");
  const chosen = page.clickTimes.find((event) => event.value === "high");
  const focused = page.focusTimes.find((event) => event.target === "TEXTAREA");
  assert.deepEqual(page.errors, []);
  assert.equal(chosen.time - opened.time, 137 + 123);
  assert.equal(focused.time - chosen.time, 7 + 200);
  assert.deepEqual(page.openings(), { total: 1, visible: 1 });
});

test("focus waits for the menu to disappear even when aria-expanded is already false", async () => {
  const page = loadContent({ menuCloseDelay: 87, clickDelay: 7 });
  await page.start();
  const chosen = page.clickTimes.find((event) => event.value === "high");
  const focused = page.focusTimes.find((event) => event.target === "TEXTAREA");
  assert.deepEqual(page.errors, []);
  assert.equal(focused.time - chosen.time, 87 + 200);
  assert.equal(focused.menuVisible, false);
});

test("polling still detects visual changes that produce no mutation notifications", async () => {
  const page = loadContent({ menuCloseDelay: 87, clickDelay: 7, noMutationNotifications: true });
  await page.start();
  const chosen = page.clickTimes.find((event) => event.value === "high");
  const focused = page.focusTimes.find((event) => event.target === "TEXTAREA");
  assert.deepEqual(page.errors, []);
  assert(focused.time - chosen.time >= 87 + 200);
  assert(focused.time - chosen.time < 87 + 200 + 100);
  assert.equal(focused.menuVisible, false);
});

for (const blockedBy of ["disabled", "readOnly", "aria-disabled", "aria-busy"]) {
  test(`focus waits for the editor to become available when blocked by ${blockedBy}`, async () => {
    const page = loadContent({ clickDelay: 7, editorReadyAfter: 937, editorBlockedBy: blockedBy });
    await page.start();
    const focused = page.focusTimes.find((event) => event.target === "TEXTAREA");
    assert.deepEqual(page.errors, []);
    assert.equal(focused.time, 937);
    assert.equal(focused.menuVisible, false);
    assert.equal(page.document.activeElement, page.editor);
    assert.equal(page.editor.value, "draft");
  });
}

test("a menu that never closes in time cannot produce success or take focus from its overlay", async () => {
  const page = loadContent({ menuCloseDelay: 10_000, clickDelay: 0 });
  await page.start();
  const chosen = page.clickTimes.find((event) => event.value === "high");
  assert(page.errors.some((error) => error.includes("did not close")));
  assert.equal(page.clock() - chosen.time, 3500);
  assert.deepEqual(page.focusTimes.filter((event) => event.target === "TEXTAREA"), []);
  assert.equal(page.activeObservers(), 0);
});

test("model selection waits for its actual update and shares the final 200 ms check", async () => {
  const page = loadContent({ initialModel: "pro-3.1", initialLevel: "high", modelClickDelay: 137 });
  await page.start();
  const chosen = page.clickTimes.find((event) => event.value === "flash-3.8");
  const focused = page.focusTimes.find((event) => event.target === "TEXTAREA");
  assert.deepEqual(page.errors, []);
  assert.equal(focused.time - chosen.time, 137 + 200);
  assert.deepEqual(page.openings(), { total: 1, visible: 1 });
});

test("combined verification checks the model throughout the thinking stability window", async () => {
  const page = loadContent({ initialModel: "pro-3.1", initialLevel: "high", modelDriftAfterClick: 150 });
  await page.start();
  assert(page.errors.length > 0);
  assert.equal(page.state().model, "pro-3.1");
  assert.equal(page.clicks.filter((value) => value === "flash-3.8").length, 2);
});

test("unrelated mutations do not restart a matching stability window", async () => {
  const page = loadContent({ clickDelay: 7 });
  for (const time of [177, 217, 257, 297, 337]) page.schedule(page.notifyObservers, time);
  await page.start();
  const chosen = page.clickTimes.find((event) => event.value === "high");
  const focused = page.focusTimes.find((event) => event.target === "TEXTAREA");
  assert.equal(focused.time - chosen.time, 7 + 200);
});

for (const ignoreClicks of [false, true]) {
  test(`waiters release their timers and observers after ${ignoreClicks ? "failure" : "success"}`, async () => {
    const page = loadContent({ ignoreClicks });
    await page.start();
    assert.equal(page.pendingTimers(), 0);
    assert.equal(page.activeObservers(), 0);
    assert.equal(page.errors.length > 0, ignoreClicks);
  });
}

for (const target of ["low", "medium", "high"]) {
  test(`confirms ${target} on the closed picker after one visible opening`, async () => {
    const page = loadContent({ initialLevel: target === "high" ? "medium" : "high",
      labels: ["α", "高", "xyz"], descriptions: true, stored: { thinkingLevel: target } });
    await page.start();
    assert.deepEqual(page.errors, []);
    assert.equal(page.state().level, target);
    assert.deepEqual(page.openings(), { total: 1, visible: 1 });
    assert.deepEqual(page.clicks.filter((value) => value !== "picker"), [target]);
  });
}

test("reads labels anew for each application without a persistent label cache", async () => {
  const page = loadContent({ initialLevel: "medium", labels: ["A", "B", "C"] });
  await page.start();
  page.setLabels(["X", "Y", "Z"]);
  const result = await page.apply({ thinkingLevel: "medium" });
  assert.equal(result.ok, true);
  assert.equal(page.state().level, "medium");
  assert.deepEqual(page.openings(), { total: 2, visible: 2 });
});

test("a menu that remains open after selection is checked without toggling it again", async () => {
  const page = loadContent({ keepMenuOpen: true, clickDelay: 800 });
  await page.start();
  assert.deepEqual(page.errors, []);
  assert.equal(page.state().level, "high");
  assert.equal(page.state().menuOpen, false);
  assert.deepEqual(page.openings(), { total: 1, visible: 1 });
});

test("duplicate target labels fail without an unverifiable click", async () => {
  const page = loadContent({ initialLevel: "high", labels: ["A", "B", "B"],
    stored: { thinkingLevel: "medium" } });
  await page.start();
  assert(page.errors.length > 0);
  assert.deepEqual(page.clicks.filter((value) => value !== "picker"), []);
  assert.deepEqual(page.openings(), { total: 1, visible: 1 });
});

test("an ignored click is retried only after failed confirmation", async () => {
  const page = loadContent({ initialLevel: "low", ignoreClicks: true });
  await page.start();
  assert(page.errors.length > 0);
  assert.equal(page.state().level, "low");
  assert.equal(page.state().menuOpen, false);
  assert.deepEqual(page.clicks.filter((value) => value !== "picker"), ["high", "high"]);
  assert.deepEqual(page.openings(), { total: 2, visible: 2 });
});

test("a failed medium switch is never accepted as high", async () => {
  const page = loadContent({ initialLevel: "high", redirectLevel: "high" });
  await page.start();
  const result = await page.apply({ thinkingLevel: "medium" });
  assert.equal(result.ok, false);
  assert.equal(page.state().level, "high");
  assert.equal(page.state().menuOpen, false);
  assert.equal(page.clicks.filter((value) => value === "medium").length, 2);
});

test("combined confirmation rejects a transient level within the stability window", async () => {
  const page = loadContent({ initialLevel: "high", driftAfterClick: "high", driftDelay: 150 });
  await page.start();
  const result = await page.apply({ thinkingLevel: "medium" });
  assert.equal(result.ok, false);
  assert.equal(page.state().level, "high");
});

test("model fallback and thinking reset preserve the requested thinking level", async () => {
  const page = loadContent({ initialModel: "pro-3.1", initialLevel: "high",
    availableModels: ["flash-lite-3.5", "flash-3.7", "pro-3.1"], resetThinkingOnModelChange: true,
    stored: { model: "flash-3.8", thinkingLevel: "medium" } });
  await page.start();
  assert.deepEqual(page.state(), { model: "flash-3.7", level: "medium", menuOpen: false });
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.openings(), { total: 2, visible: 2 });
  assert.deepEqual(page.clicks.filter((value) => value !== "picker"), ["flash-3.7", "medium"]);
});

test("changing only the model uses one opening when the thinking level is preserved", async () => {
  const page = loadContent({ initialModel: "pro-3.1", initialLevel: "medium",
    stored: { model: "flash-3.8", thinkingLevel: "medium" } });
  await page.start();
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.state(), { model: "flash-3.8", level: "medium", menuOpen: false });
  assert.deepEqual(page.openings(), { total: 1, visible: 1 });
  assert.deepEqual(page.clicks.filter((value) => value !== "picker"), ["flash-3.8"]);
});

test("a model reset that already reaches the requested level needs no second opening", async () => {
  const page = loadContent({ initialModel: "pro-3.1", initialLevel: "high", resetThinkingOnModelChange: true,
    stored: { model: "flash-3.8", thinkingLevel: "low" } });
  await page.start();
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.state(), { model: "flash-3.8", level: "low", menuOpen: false });
  assert.deepEqual(page.openings(), { total: 1, visible: 1 });
  assert.deepEqual(page.clicks.filter((value) => value !== "picker"), ["flash-3.8"]);
});

test("an already selected fallback model reuses the open menu to set thinking", async () => {
  const page = loadContent({ initialModel: "flash-3.7", initialLevel: "low",
    availableModels: ["flash-lite-3.5", "flash-3.7", "pro-3.1"],
    stored: { model: "flash-3.8", thinkingLevel: "medium" } });
  await page.start();
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.state(), { model: "flash-3.7", level: "medium", menuOpen: false });
  assert.deepEqual(page.openings(), { total: 1, visible: 1 });
  assert.deepEqual(page.clicks.filter((value) => value !== "picker"), ["medium"]);
});

test("ambiguous selection indicators do not produce a false success", async () => {
  const page = loadContent({ initialLevel: "high", multipleSelected: true });
  await page.start();
  assert(page.errors.length > 0);
  assert.equal(page.state().menuOpen, false);
  assert.deepEqual(page.clicks.filter((value) => value !== "picker"), []);
});

test("incomplete radio groups are not treated as a legacy toggle", async () => {
  const page = loadContent({ role: "menuitemradio", levelCount: 1 });
  await page.start();
  assert(page.errors.length > 0);
  assert.deepEqual(page.clicks.filter((value) => value !== "picker"), []);
});

test("unavailable levels fail without clicking a disabled item", async () => {
  const page = loadContent({ disabledLevel: "high" });
  await page.start();
  assert(page.errors.some((message) => message.includes("not available")));
  assert(!page.clicks.includes("high"));
});

test("sync changes preserve manual selection and apply on the next explicit request", async () => {
  const page = loadContent();
  await page.start();
  page.setLevel("medium");
  const clicksBeforeSync = page.clicks.length;
  page.changeStorage({ extendedThinking: { newValue: false } });
  assert.equal(page.state().level, "medium");
  assert.equal(page.clicks.length, clicksBeforeSync);
  const result = await page.apply({ extendedThinking: false });
  assert.equal(result.ok, true);
  assert.equal(page.state().level, "low");
});

test("queued apply requests each use their own settings snapshot", async () => {
  const page = loadContent();
  await page.start();
  const first = page.send({ thinkingLevel: "low" });
  const second = page.send({ thinkingLevel: "medium" });
  await page.runUntil(() => first.done() && second.done());
  assert.equal(first.response().ok, true);
  assert.equal(second.response().ok, true);
  assert.deepEqual(page.clicks.filter((value) => value !== "picker"), ["high", "low", "medium"]);
});

for (const target of ["low", "medium", "high"]) {
  test(`selects nested ${target} using position and confirms it without reopening`, async () => {
    const page = loadContent({ nestedThinking: true, initialLevel: target === "high" ? "medium" : "high",
      labels: ["α", "β", "γ"], stored: { model: "flash-3.8", thinkingLevel: target },
      unrelatedMenu: true, clickDelay: 0 });
    await page.start();
    assert.deepEqual(page.errors, []);
    assert.deepEqual(page.state(), { model: "flash-3.8", level: target, menuOpen: false });
    assert.deepEqual(page.clicks, ["picker", "thinking-submenu", target]);
    assert.deepEqual(page.openings(), { total: 1, visible: 1 });
    const clicked = page.clickTimes.find((entry) => entry.value === target);
    const focused = page.focusTimes.find((entry) => entry.target === "TEXTAREA");
    assert.equal(focused.time - clicked.time, 200);
    assert.equal(page.document.querySelector('#thinking-menu'), null);
    assert.equal(page.editor.value, "draft");
  });
}

for (const submenuLink of ["owns", "labelledby", "nested"]) {
  test(`finds the thinking submenu through ${submenuLink} without using unrelated menus`, async () => {
    const page = loadContent({ nestedThinking: true, submenuLink, unrelatedMenu: true,
      initialLevel: "medium", role: "menuitemradio", indicator: "aria", noControls: true });
    await page.start();
    assert.deepEqual(page.errors, []);
    assert.equal(page.state().level, "high");
    assert.deepEqual(page.clicks, ["picker", "thinking-submenu", "high"]);
  });
}

test("selects Argon before checking its nested thinking options", async () => {
  const page = loadContent({ nestedThinking: true, initialLevel: "medium",
    stored: { model: "argon-4", thinkingLevel: "medium" } });
  await page.start();
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.state(), { model: "argon-4", level: "medium", menuOpen: false });
  assert.deepEqual(page.clicks, ["picker", "argon-4", "picker", "thinking-submenu"]);
  assert.deepEqual(page.openings(), { total: 2, visible: 2 });
});

test("restores nested thinking after Argon resets it", async () => {
  const page = loadContent({ nestedThinking: true, initialLevel: "high", resetThinkingOnModelChange: true,
    stored: { model: "argon-4", thinkingLevel: "medium" } });
  await page.start();
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.state(), { model: "argon-4", level: "medium", menuOpen: false });
  assert.deepEqual(page.clicks, ["picker", "argon-4", "picker", "thinking-submenu", "medium"]);
  assert.deepEqual(page.openings(), { total: 2, visible: 2 });
});

test("already selected nested thinking closes both menus without clicking the level", async () => {
  const page = loadContent({ nestedThinking: true, initialLevel: "high", submenuEscapeOnly: true,
    submenuCloseDelay: 120, menuCloseDelay: 80, editorFocused: false });
  await page.start();
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.clicks, ["picker", "thinking-submenu"]);
  assert.deepEqual(page.keyboardEvents.map((entry) => entry.key), ["Escape", "Escape"]);
  assert.equal(page.state().menuOpen, false);
  assert.equal(page.document.querySelector('#thinking-menu'), null);
  assert.notEqual(page.document.activeElement, page.editor);
});

test("waits for nested options and selection indicators without fixed delays", async () => {
  const page = loadContent({ nestedThinking: true, submenuDelay: 120, selectionDelay: 60,
    initialLevel: "medium", disabledLevel: "high", enableLevelAfter: 75, clickDelay: 0 });
  await page.start();
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.clicks, ["picker", "thinking-submenu", "high"]);
  const opened = page.clickTimes.find((entry) => entry.value === "thinking-submenu");
  const chosen = page.clickTimes.find((entry) => entry.value === "high");
  assert.equal(chosen.time - opened.time, 195);
});

test("a submenu that never opens is not clicked as a legacy toggle", async () => {
  const page = loadContent({ nestedThinking: true, ignoreSubmenuClicks: true });
  await page.start();
  assert(page.errors.length > 0);
  assert.deepEqual(page.clicks, ["picker", "thinking-submenu"]);
  assert.equal(page.state().level, "low");
  assert.equal(page.state().menuOpen, false);
});

test("opens a hover-only thinking submenu without an extra fixed pause", async () => {
  const page = loadContent({ nestedThinking: true, hoverOnlySubmenu: true, clickDelay: 0 });
  await page.start();
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.clicks, ["picker", "thinking-submenu", "thinking-hover", "high"]);
  assert.equal(page.state().level, "high");
  const opened = page.clickTimes.find((entry) => entry.value === "picker");
  const chosen = page.clickTimes.find((entry) => entry.value === "high");
  assert.equal(chosen.time, opened.time);
});

test("waits for an independently closing submenu before restoring focus", async () => {
  const page = loadContent({ nestedThinking: true, submenuCloseDelay: 340, clickDelay: 0 });
  await page.start();
  assert.deepEqual(page.errors, []);
  const chosen = page.clickTimes.find((entry) => entry.value === "high");
  const focused = page.focusTimes.find((entry) => entry.target === "TEXTAREA");
  assert(focused.time - chosen.time >= 540);
  assert.equal(page.document.querySelector('#thinking-menu'), null);
});

const currentModels = ["flash-lite-3.5", "flash-3.8", "pro-3.1", "argon-4", "carbon-4"];

for (const target of currentModels) {
  test(`selects ${target} in the five-model menu with descriptions before model names`, async () => {
    const page = loadContent({ descriptionFirst: true, noModelIds: true, noControls: true,
      noMenuTestId: true, unrelatedMenu: true, nestedThinking: true, shortPickerLabels: true,
      availableModels: currentModels, initialModel: target === "pro-3.1" ? "argon-4" : "pro-3.1",
      initialLevel: "medium", stored: { model: target, thinkingLevel: "medium" } });
    await page.start();
    assert.deepEqual(page.errors, []);
    assert.deepEqual(page.state(), { model: target, level: "medium", menuOpen: false });
    assert.deepEqual(page.clicks, ["picker", target, "picker", "thinking-submenu"]);
    assert.deepEqual(page.openings(), { total: 2, visible: 2 });
    assert.equal(page.editor.value, "draft");
  });
}

test("a locked Carbon row does not interfere with the current model's thinking options", async () => {
  const page = loadContent({ descriptionFirst: true, noModelIds: true, nestedThinking: true,
    availableModels: currentModels, disabledModel: "carbon-4", modelBlocker: "lock-icon" });
  await page.start();
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.state(), { model: "flash-3.8", level: "high", menuOpen: false });
  assert.deepEqual(page.clicks, ["picker", "thinking-submenu", "high"]);
});

for (const modelBlocker of ["aria-disabled", "disabled", "nested-disabled", "lock-icon", "lock-text", "lock-fonticon"]) {
  test(`a Carbon model blocked by ${modelBlocker} is never clicked and reports account availability`, async () => {
    const page = loadContent({ descriptionFirst: true, noModelIds: true, nestedThinking: true,
      availableModels: currentModels, disabledModel: "carbon-4", modelBlocker, initialLevel: "medium" });
    const request = page.send({ model: "carbon-4", thinkingLevel: "high" });
    await page.runUntil(request.done);
    assert.equal(request.response().ok, false);
    assert.match(request.response().error, /4 Carbon is unavailable for this account/);
    assert.deepEqual(page.state(), { model: "flash-3.8", level: "medium", menuOpen: false });
    assert.deepEqual(page.clicks, ["picker"]);
    assert.equal(page.document.activeElement, page.editor);
    assert.equal(page.pendingTimers(), 0);
    assert.equal(page.activeObservers(), 0);
  });
}

test("a locked primary model does not silently switch to its older fallback", async () => {
  const page = loadContent({ availableModels: ["flash-3.8", "flash-3.7", "pro-3.1"],
    initialModel: "pro-3.1", disabledModel: "flash-3.8", modelBlocker: "lock-icon" });
  await page.start();
  assert(page.errors.some((message) => message.includes("3.8 Flash is unavailable")));
  assert.deepEqual(page.clicks, ["picker"]);
  assert.equal(page.state().model, "pro-3.1");
});

test("waits for a temporarily disabled model before selecting it", async () => {
  const page = loadContent({ descriptionFirst: true, nestedThinking: true, availableModels: currentModels,
    initialLevel: "high", disabledModel: "carbon-4", enableModelAfter: 120,
    stored: { model: "carbon-4", thinkingLevel: "high" } });
  await page.start();
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.state(), { model: "carbon-4", level: "high", menuOpen: false });
  assert.deepEqual(page.clicks, ["picker", "carbon-4", "picker", "thinking-submenu"]);
});

test("a five-model inline thinking menu excludes all model rows without model ids", async () => {
  const page = loadContent({ descriptionFirst: true, noModelIds: true, availableModels: currentModels });
  await page.start();
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.state(), { model: "flash-3.8", level: "high", menuOpen: false });
  assert.deepEqual(page.clicks, ["picker", "high"]);
});

test("the new row layout still falls back to Flash 3.7 during rollout", async () => {
  const page = loadContent({ descriptionFirst: true, noModelIds: true, noControls: true, noMenuTestId: true,
    availableModels: ["flash-lite-3.5", "flash-3.7", "pro-3.1"], nestedThinking: true,
    initialModel: "pro-3.1", initialLevel: "medium",
    stored: { model: "flash-3.8", thinkingLevel: "medium" } });
  await page.start();
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.state(), { model: "flash-3.7", level: "medium", menuOpen: false });
  assert.deepEqual(page.clicks, ["picker", "flash-3.7", "picker", "thinking-submenu"]);
});

test("Carbon missing from the old menu fails once and keeps the current settings", async () => {
  const page = loadContent({ legacy: true, initialLevel: "low",
    stored: { model: "carbon-4", thinkingLevel: "high" } });
  await page.start();
  assert(page.errors.some((message) => message.includes("Could not find the 4 Carbon")));
  assert.deepEqual(page.state(), { model: "flash-3.8", level: "low", menuOpen: false });
  assert.deepEqual(page.clicks, ["picker"]);
  assert.equal(page.pendingTimers(), 0);
});

for (const [model, thinkingLevel] of [["argon-4", "medium"], ["flash-3.8", "high"]]) {
  test(`startup repairs a delayed reset to low for ${model} ${thinkingLevel}`, async () => {
    const page = loadContent({ initialModel: "pro-3.1", initialLevel: thinkingLevel,
      nestedThinking: true, delayedThinkingReset: 650, stored: { model, thinkingLevel } });
    let settled = false;
    page.schedule(() => { settled = true; }, 1800);
    await page.runUntil(() => settled);
    assert.deepEqual(page.errors, []);
    assert.deepEqual(page.state(), { model, level: thinkingLevel, menuOpen: false });
    assert.equal(page.clicks.filter((value) => value === thinkingLevel).length, 1);
    await page.start();
    assert.equal(page.pendingTimers(), 0);
    assert.equal(page.documentListenerCount(), 0);
  });
}

test("startup repairs a hydration reset even when the preferred model was already selected", async () => {
  const page = loadContent({ initialLevel: "high" });
  page.schedule(() => page.setLevel("low"), 900);
  let settled = false;
  page.schedule(() => { settled = true; }, 1800);
  await page.runUntil(() => settled);
  assert.equal(page.state().level, "high");
  assert.deepEqual(page.errors, []);
  await page.start();
});

for (const eventType of ["pointerdown", "keydown", "input"]) {
  test(`a trusted ${eventType} stops startup recovery and preserves manual thinking`, async () => {
    const page = loadContent();
    await page.runUntil(() => page.focusTimes.some((entry) => entry.target === "TEXTAREA"));
    page.interact(eventType);
    page.setLevel("medium");
    let settled = false;
    page.schedule(() => { settled = true; }, 1000);
    await page.runUntil(() => settled);
    assert.equal(page.state().level, "medium");
    assert.deepEqual(page.openings(), { total: 1, visible: 1 });
    assert.equal(page.activeObservers(), 0);
    assert.equal(page.documentListenerCount(), 0);
  });
}

test("synthetic menu events do not disable recovery from a late startup reset", async () => {
  const page = loadContent();
  await page.runUntil(() => page.focusTimes.some((entry) => entry.target === "TEXTAREA"));
  page.interact("keydown", false);
  page.setLevel("low");
  let settled = false;
  page.schedule(() => { settled = true; }, 1000);
  await page.runUntil(() => settled);
  assert.equal(page.state().level, "high");
  await page.start();
});

test("an explicit preference cancels startup recovery of the previous preference", async () => {
  const page = loadContent();
  await page.runUntil(() => page.focusTimes.some((entry) => entry.target === "TEXTAREA"));
  page.setLevel("low");
  const result = await page.apply({ model: "argon-4", thinkingLevel: "medium" });
  assert.equal(result.applied, true);
  assert.deepEqual(page.state(), { model: "argon-4", level: "medium", menuOpen: false });
  assert.equal(page.pendingTimers(), 0);
  assert.equal(page.activeObservers(), 0);
  assert.equal(page.documentListenerCount(), 0);
});

test("startup recovery is bounded when Gemini keeps reverting the thinking level", async () => {
  const page = loadContent({ driftAfterClick: "low", driftDelay: 650 });
  await page.start();
  let settled = false;
  page.schedule(() => { settled = true; }, 1000);
  await page.runUntil(() => settled);
  assert.equal(page.state().level, "low");
  assert.equal(page.clicks.filter((value) => value === "high").length, 2);
  assert.equal(page.pendingTimers(), 0);
  assert.equal(page.activeObservers(), 0);
  assert.equal(page.documentListenerCount(), 0);
});

for (const delayedUi of [{ menuDelay: 4500 }, { nestedThinking: true, submenuDelay: 4500 },
  { selectionDelay: 4500 }, { clickDelay: 4500 }]) {
  test(`cold startup waits for delayed UI: ${JSON.stringify(delayedUi)}`, async () => {
    const page = loadContent(delayedUi);
    await page.start();
    assert.deepEqual(page.errors, []);
    assert.equal(page.state().level, "high");
    assert.equal(page.state().menuOpen, false);
    assert.equal(page.pendingTimers(), 0);
    assert.equal(page.clicks.filter((value) => value === "high").length, 1);
  });
}

test("a slow initial storage snapshot cannot overwrite a newer synced thinking level", async () => {
  const page = loadContent({ deferStorage: true, stored: { thinkingLevel: "low" } });
  page.changeStorage({ thinkingLevel: { newValue: "medium" } });
  page.finishStorage();
  await page.start();
  assert.equal(page.state().level, "medium");
  assert.deepEqual(page.errors, []);
});

test("deleting a preference during the initial storage read still uses legacy migration", async () => {
  const page = loadContent({ deferStorage: true,
    stored: { thinkingLevel: "high", extendedThinking: false } });
  page.changeStorage({ thinkingLevel: { oldValue: "high" } });
  page.finishStorage();
  await page.start();
  assert.equal(page.state().level, "low");
});

for (const nestedThinking of [false, true]) {
  test(`switching models does not require thinking options on the previous model (nested=${nestedThinking})`, async () => {
    const page = loadContent({ initialModel: "flash-lite-3.5", modelsWithoutThinking: ["flash-lite-3.5"],
      nestedThinking, stored: { model: "argon-4", thinkingLevel: "medium" } });
    await page.start();
    assert.deepEqual(page.errors, []);
    assert.deepEqual(page.state(), { model: "argon-4", level: "medium", menuOpen: false });
    assert.deepEqual(page.clicks.filter((value) => !["picker", "thinking-submenu"].includes(value)),
      ["argon-4", "medium"]);
    assert(page.clickTimes.find((entry) => entry.value === "argon-4").time < 500);
  });
}

for (const [initialModel, storedModel] of [["flash-3.8", "argon-4"], ["argon-4", "flash-3.8"]]) {
  test(`visible ${initialModel} overrides a stale aria-label naming ${storedModel}`, async () => {
    const page = loadContent({ initialModel, pickerAriaLabel: `Mode picker, ${storedModel === "argon-4" ? "4 Argon" : "3.8 Flash"}`,
      stored: { model: storedModel, thinkingLevel: "medium" } });
    await page.start();
    assert.deepEqual(page.errors, []);
    assert.deepEqual(page.state(), { model: storedModel, level: "medium", menuOpen: false });
    assert(page.clicks.includes(storedModel));
  });
}

test("startup repairs late replacement of the model picker and both model settings", async () => {
  const page = loadContent({ stored: { model: "argon-4", thinkingLevel: "medium" } });
  page.schedule(() => page.replacePicker("flash-3.8", "low"), 1000);
  await page.start();
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.state(), { model: "argon-4", level: "medium", menuOpen: false });
  assert.equal(page.clicks.filter((value) => value === "argon-4").length, 2);
});

test("a trusted model selection stops recovery as well as a thinking selection", async () => {
  const page = loadContent({ stored: { model: "argon-4", thinkingLevel: "medium" } });
  await page.runUntil(() => page.focusTimes.some((entry) => entry.target === "TEXTAREA"));
  page.interact();
  page.setModel("pro-3.1");
  let settled = false;
  page.schedule(() => { settled = true; }, 1000);
  await page.runUntil(() => settled);
  assert.equal(page.state().model, "pro-3.1");
  assert.equal(page.clicks.filter((value) => value === "argon-4").length, 1);
  assert.equal(page.activeObservers(), 0);
});

for (const delayedUi of [{ pickerReadyAfter: 5000 }, { pickerEnabledAfter: 5000 },
  { initialModel: "pro-3.1", modelClickDelay: 4500 }]) {
  test(`cold startup waits for the model interface: ${JSON.stringify(delayedUi)}`, async () => {
    const page = loadContent(delayedUi);
    await page.start();
    assert.deepEqual(page.errors, []);
    assert.deepEqual(page.state(), { model: "flash-3.8", level: "high", menuOpen: false });
    assert.equal(page.pendingTimers(), 0);
    if (delayedUi.modelClickDelay) {
      assert.equal(page.clicks.filter((value) => value === "flash-3.8").length, 1);
    }
  });
}

test("a slow initial snapshot also preserves a newer synced model", async () => {
  const page = loadContent({ deferStorage: true, stored: { model: "flash-3.8", thinkingLevel: "low" } });
  page.changeStorage({ model: { newValue: "argon-4" }, thinkingLevel: { newValue: "medium" } });
  page.finishStorage();
  await page.start();
  assert.deepEqual(page.state(), { model: "argon-4", level: "medium", menuOpen: false });
  assert.deepEqual(page.errors, []);
});

test("trusted input during a running recovery prevents its delayed clicks and focus changes", async () => {
  const page = loadContent({ menuDelay: 300 });
  await page.runUntil(() => page.focusTimes.some((entry) => entry.target === "TEXTAREA"));
  page.setLevel("low");
  await page.runUntil(() => page.clicks.filter((value) => value === "picker").length === 2);
  const focusCount = page.focusTimes.length;
  page.interact("input");
  page.setLevel("medium");
  await page.start();
  let settled = false;
  page.schedule(() => { settled = true; }, 500);
  await page.runUntil(() => settled);
  assert.equal(page.state().level, "medium");
  assert.equal(page.clicks.filter((value) => value === "high").length, 1);
  assert.equal(page.focusTimes.length, focusCount);
  assert.equal(page.documentListenerCount(), 0);
  assert.equal(page.pendingTimers(), 0);
  assert.deepEqual(page.errors, []);
});

test("startup gives up cleanly when the picker never appears within its cold-start budget", async () => {
  const page = loadContent();
  page.picker.hidden = true;
  await page.start();
  assert.equal(page.state().level, "low");
  assert.deepEqual(page.clicks, []);
  assert(page.errors.some((message) => message.includes("not ready")));
  assert.equal(page.pendingTimers(), 0);
  assert.equal(page.activeObservers(), 0);
  assert.equal(page.documentListenerCount(), 0);
});

test("a delayed background startup signal cannot restart a recovery cancelled by manual input", async () => {
  const page = loadContent({ menuDelay: 300 });
  await page.runUntil(() => page.focusTimes.some((entry) => entry.target === "TEXTAREA"));
  page.setLevel("low");
  await page.runUntil(() => page.clicks.filter((value) => value === "picker").length === 2);
  page.interact("input");
  page.setLevel("medium");
  const request = page.send({ thinkingLevel: "high" }, { initialApplication: true, waitForUi: true });
  await page.runUntil(request.done);
  assert.equal(request.response().cancelled, true);
  assert.equal(page.state().level, "medium");
  assert.equal(page.clicks.filter((value) => value === "high").length, 1);
});

test("sync changes during startup prevent a later watchdog from restoring an obsolete preference", async () => {
  const page = loadContent({ clickDelay: 600 });
  await page.runUntil(() => page.clicks.includes("high"));
  page.changeStorage({ model: { newValue: "argon-4" }, thinkingLevel: { newValue: "medium" } });
  await page.start();
  page.setLevel("low");
  let settled = false;
  page.schedule(() => { settled = true; }, 1000);
  await page.runUntil(() => settled);
  assert.equal(page.state().level, "low");
  assert.equal(page.clicks.filter((value) => value === "high").length, 1);
  assert.equal(page.documentListenerCount(), 0);
});
