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
  let initialComplete = false;
  let model = options.initialModel || "flash-3.8";
  let level = options.initialLevel || "low";
  let menuOpen = false;
  let menuOpenings = 0;
  let visibleMenuOpenings = 0;
  let menu;
  const levels = ["low", "medium", "high"];
  let labels = options.labels || ["Низкая", "Средний", "Высокая"];
  const stored = options.stored || { model: "flash-3.8", thinkingLevel: "high" };
  const modelLabels = {
    "flash-lite-3.5": "3.5 Flash-Lite",
    "flash-3.8": "3.8 Flash",
    "flash-3.7": "3.7 Flash",
    "pro-3.1": "3.1 Pro"
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
      keyboardEvents.push({ type: event.type, key: event.key, keyCode: event.keyCode,
        bubbles: event.bubbles, time: now });
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
    constructor() { super("textarea", { "aria-label": "prompt" }); this.value = "draft"; }
    setSelectionRange(start, end) { this.selection = [start, end]; }
  }
  const document = new Element("document");
  document.documentElement = document;
  document.hidden = Boolean(options.backgroundTab);
  // Document.hidden describes the tab's visibility; its DOM still has layout.
  document.getClientRects = () => [{}];
  document.head = document.append(new Element("head"));
  document.createElement = (tag) => new Element(tag);
  for (const css of contentStyles) document.head.append(new Element("style", {}, css));
  document.getSelection = () => null;
  document.getElementById = (id) => document.querySelectorAll("*").find((element) => element.attrs.id === id) || null;
  if (options.profileMenu) document.append(new Element("button", { "aria-haspopup": "menu" }, "Profile"));
  const picker = document.append(new Element("button", {
    "aria-haspopup": "true", "aria-expanded": "false", "aria-controls": "mode-menu"
  }));
  picker.classes.add("input-area-switch");
  const editor = document.append(new TextArea());
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
    picker.text = modelLabels[model];
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
    if (menu) {
      const closingMenu = menu;
      const closingPanel = closingMenu.closest(".cdk-overlay-pane");
      const removeMenu = () => { (closingPanel || closingMenu).remove(); notifyObservers(); };
      if (animate && options.menuCloseDelay) setTimer(removeMenu, options.menuCloseDelay);
      else removeMenu();
    }
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
    for (const id of options.availableModels || ["flash-lite-3.5", "flash-3.8", "pro-3.1"]) {
      const item = menu.append(new Element("gem-menu-item", { role: "menuitem", "data-mode-id": id }, modelLabels[id]));
      markSelected(item, model === id);
      item.onClick = () => {
        recordClick(id);
        closeMenu(true);
        const update = () => {
          if (!options.ignoreModelClicks) model = id;
          if (options.resetThinkingOnModelChange) level = "low";
          refreshPicker();
          if (options.modelDriftAfterClick) {
            setTimer(() => { model = options.initialModel; refreshPicker(); }, options.modelDriftAfterClick);
          }
        };
        if (options.modelClickDelay) setTimer(update, options.modelClickDelay);
        else update();
      };
    }
    if (options.separator !== false) menu.append(new Element("mat-divider", { role: "separator" }));
    const menuLevels = options.legacy ? ["high"] : levels.slice(0, options.levelCount ?? 3);
    for (const itemLevel of menuLevels) {
      const nativeRadio = options.role === "native";
      const role = options.legacy ? "menuitemcheckbox" : options.role || "menuitem";
      const item = menu.append(new Element(nativeRadio ? "input" : "gem-menu-item",
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
    if (options.extraLegacyToggle) {
      const legacy = menu.append(new Element("gem-menu-item", { role: "menuitemcheckbox" }, "Old"));
      legacy.onClick = () => { clicks.push("unexpected-legacy"); };
    }
    notifyObservers();
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
        callback(Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, stored[key]])));
      } },
      onChanged: { addListener(listener) { storageListener = listener; } }
    },
    runtime: { onMessage: { addListener(listener) { messageListener = listener; } } }
  };
  const context = vm.createContext({
    document, chrome, HTMLElement: Element, HTMLTextAreaElement: TextArea,
    KeyboardEvent: KeyEvent,
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
    clicks, clickTimes, focusTimes, keyboardEvents, errors, editor, picker, document, computedStyle,
    clock: () => now,
    pendingTimers: () => timers.size,
    activeObservers: () => observers.filter((entry) => entry.observing).length,
    notifyObservers,
    schedule: setTimer,
    state: () => ({ model, level, menuOpen }),
    openings: () => ({ total: menuOpenings, visible: visibleMenuOpenings }),
    async start() { await runUntil(() => initialComplete); },
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
    setLevel(value) { level = value; refreshPicker(); },
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
  assert.equal(page.clock() - opened.time, 200);
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
