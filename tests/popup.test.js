const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const sharedSource = fs.readFileSync(
  path.join(__dirname, "..", "shared.js"),
  "utf8"
);
const popupSource = fs.readFileSync(
  path.join(__dirname, "..", "popup.js"),
  "utf8"
);

function createPopupMock(initialStorage = {}) {
  let stored = { ...initialStorage };
  const tabsSent = [];
  const runtimeSent = [];

  // Simple DOM simulation
  const elements = {
    "#settings-panel": {
      listeners: {},
      addEventListener(type, cb) {
        this.listeners[type] = cb;
      },
      trigger(type) {
        if (this.listeners[type]) this.listeners[type]();
      },
      querySelector(sel) {
        const checkedModelMatch = sel.match(/input\[name="model"\]:checked/);
        if (checkedModelMatch) {
          return models.find((m) => m.checked) || null;
        }
        const modelValMatch = sel.match(/input\[name="model"\]\[value="([^"]+)"\]/);
        if (modelValMatch) {
          return models.find((m) => m.value === modelValMatch[1]) || null;
        }
        const checkedThinkingMatch = sel.match(/input\[name="thinkingLevel"\]:checked/);
        if (checkedThinkingMatch) {
          return thinkings.find((t) => t.checked) || null;
        }
        const thinkingValMatch = sel.match(/input\[name="thinkingLevel"\]\[value="([^"]+)"\]/);
        if (thinkingValMatch) {
          return thinkings.find((t) => t.value === thinkingValMatch[1]) || null;
        }
        return null;
      }
    },
    "#open-gemini": { addEventListener() {} },
    "#open-gemini-shortcut": { textContent: "" },
    "#open-gemini-shortcut-change": { addEventListener() {} },
    "#status": { textContent: "", dataset: {}, replaceChildren() {} }
  };

  const models = [
    { name: "model", value: "flash-lite-3.5", checked: false },
    { name: "model", value: "flash-3.8", checked: false },
    { name: "model", value: "pro-3.1", checked: false }
  ];

  const thinkings = [
    { name: "thinkingLevel", value: "low", checked: false },
    { name: "thinkingLevel", value: "medium", checked: false },
    { name: "thinkingLevel", value: "high", checked: false }
  ];

  const chrome = {
    commands: {
      async getAll() {
        return [{ name: "open-gemini", shortcut: "Ctrl+Shift+G" }];
      }
    },
    runtime: {
      async sendMessage(msg) {
        runtimeSent.push(msg);
        return { ok: true };
      }
    },
    storage: {
      sync: {
        get(keys, cb) {
          cb(Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, stored[key]])));
        },
        async set(items) {
          stored = { ...stored, ...items };
        }
      }
    },
    tabs: {
      async query() {
        return [{ id: 101 }];
      },
      async sendMessage(tabId, msg) {
        tabsSent.push({ tabId, msg });
        return { ok: true, applied: true };
      }
    }
  };

  const document = {
    querySelector(sel) {
      return elements[sel] || null;
    },
    createElement() {
      return { href: "", target: "", rel: "", textContent: "" };
    },
    createTextNode(t) {
      return t;
    }
  };

  const context = vm.createContext({
    chrome,
    document,
    setTimeout,
    clearTimeout,
    console
  });

  vm.runInContext(sharedSource, context);
  vm.runInContext(popupSource, context);

  return {
    getStored: () => stored,
    models,
    thinkings,
    panel: elements["#settings-panel"],
    status: elements["#status"],
    tabsSent
  };
}

test("loads settings into popup inputs", () => {
  const { models, thinkings } = createPopupMock({
    model: "pro-3.1",
    thinkingLevel: "medium"
  });

  assert.equal(models.find((m) => m.value === "pro-3.1").checked, true);
  assert.equal(thinkings.find((t) => t.value === "medium").checked, true);
});

test("migrates a disabled legacy preference when the popup loads", () => {
  const mock = createPopupMock({ extendedThinking: false });
  assert.equal(mock.thinkings.find((item) => item.checked).value, "low");
});

test("loads defaults when storage is empty", () => {
  const mock = createPopupMock();
  assert.equal(mock.thinkings.find((item) => item.checked).value, "high");
  assert.equal(mock.models.find((item) => item.checked).value, "flash-3.8");
});

test("saves updated thinkingLevel and applies to active tab", async () => {
  const mock = createPopupMock({
    model: "flash-3.8",
    thinkingLevel: "high"
  });

  // User selects "low"
  mock.thinkings.forEach((t) => (t.checked = t.value === "low"));
  mock.panel.trigger("change");

  // Wait for debounce timer
  await new Promise((r) => setTimeout(r, 200));

  const stored = mock.getStored();
  assert.equal(stored.thinkingLevel, "low");
  assert.equal(stored.extendedThinking, false);
  assert.equal(mock.tabsSent.length, 1);
  assert.equal(mock.tabsSent[0].msg.settings.thinkingLevel, "low");
});
