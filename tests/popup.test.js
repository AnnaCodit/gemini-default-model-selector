const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const sharedSource = fs.readFileSync(
  path.join(__dirname, "..", "shared.js"),
  "utf8"
);
const popupHtml = fs.readFileSync(
  path.join(__dirname, "..", "popup.html"),
  "utf8"
);
const popupSource = fs.readFileSync(
  path.join(__dirname, "..", "popup.js"),
  "utf8"
);

function createPopupMock(initialStorage = {}, options = {}) {
  let stored = { ...initialStorage };
  const runtimeSent = [];
  const pendingRuntimeResponses = [];
  let pendingStorageGet = null;
  let popupClosed = false;
  const permissionQueries = [];
  const tabCreates = [];

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
    "#site-access-settings": {
      listeners: {},
      addEventListener(type, cb) { this.listeners[type] = cb; },
      trigger(type) { return this.listeners[type]?.(); }
    },
    "#site-access-warning": { hidden: true },
    "#status": {
      textContent: "", dataset: {}, children: [],
      replaceChildren(...children) { this.children = children; }
    }
  };

  const models = Array.from(
    popupHtml.matchAll(
      /<input\b(?=[^>]*\bname="model")(?=[^>]*\bvalue="([^"]+)")[^>]*>/g
    ),
    (match) => ({ name: "model", value: match[1], checked: false })
  );

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
      id: "test-extension-id",
      sendMessage(msg) {
        runtimeSent.push(msg);
        if (options.runtimeMessageError) {
          return Promise.reject(new Error("background unavailable"));
        }
        if (options.deferRuntimeMessages) {
          return new Promise((resolve) => pendingRuntimeResponses.push(resolve));
        }
        return Promise.resolve(options.runtimeResponse || {
          ok: true, saved: true, applied: true
        });
      }
    },
    permissions: {
      contains(details) {
        permissionQueries.push(details);
        if (options.permissionError) {
          return Promise.reject(new Error("permission state unavailable"));
        }
        return Promise.resolve(options.permissionResult ?? true);
      }
    },
    storage: {
      sync: {
        get(keys, cb) {
          const snapshot = Object.fromEntries(keys.filter((key) => key in stored)
            .map((key) => [key, stored[key]]));
          if (options.deferStorageGet) pendingStorageGet = () => cb(snapshot);
          else cb(snapshot);
        }
      }
    },
    tabs: {
      async create(options) {
        tabCreates.push(options);
        return { id: 102, ...options };
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
    siteAccessWarning: elements["#site-access-warning"],
    siteAccessSettingsButton: elements["#site-access-settings"],
    status: elements["#status"],
    runtimeSent,
    permissionQueries,
    tabCreates,
    closePopup() { popupClosed = true; },
    isPopupClosed: () => popupClosed,
    resolveRuntimeMessage(index, result) {
      pendingRuntimeResponses[index]?.(result);
    },
    finishStorageGet() {
      pendingStorageGet?.();
    }
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("popup operation did not complete in time");
}

test("loads settings without saving or applying on popup open", () => {
  const mock = createPopupMock({
    model: "pro-3.1",
    thinkingLevel: "medium"
  });

  assert.equal(mock.models.find((m) => m.value === "pro-3.1").checked, true);
  assert.equal(mock.thinkings.find((t) => t.value === "medium").checked, true);
  assert.equal(mock.runtimeSent.length, 0);
  assert.equal(mock.panel.inert, false);
});

test("shows the Gemini site access warning when permanent access is withheld", async () => {
  const mock = createPopupMock({}, { permissionResult: false });

  assert.equal(mock.siteAccessWarning.hidden, true);
  await waitFor(() => !mock.siteAccessWarning.hidden);

  assert.deepEqual(JSON.parse(JSON.stringify(mock.permissionQueries)), [{
    origins: ["https://gemini.google.com/*"]
  }]);
  assert.equal(mock.runtimeSent.length, 0);
  assert.equal(mock.panel.inert, false);
});

test("keeps the Gemini site access warning hidden when permanent access is granted", async () => {
  const mock = createPopupMock({}, { permissionResult: true });

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(mock.permissionQueries)), [{
    origins: ["https://gemini.google.com/*"]
  }]);
  assert.equal(mock.siteAccessWarning.hidden, true);
  assert.equal(mock.runtimeSent.length, 0);
});

test("keeps the site access warning hidden when permission state is unknown", async () => {
  const mock = createPopupMock({}, { permissionError: true });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(mock.siteAccessWarning.hidden, true);
  assert.equal(mock.runtimeSent.length, 0);
});

test("opens this extension's settings when site access settings is clicked", async () => {
  const mock = createPopupMock({}, { permissionResult: false });

  mock.siteAccessSettingsButton.trigger("click");
  await waitFor(() => mock.tabCreates.length === 1);

  assert.deepEqual(JSON.parse(JSON.stringify(mock.tabCreates)), [{
    url: "chrome://extensions/?id=test-extension-id"
  }]);
  assert.equal(mock.runtimeSent.length, 0);
});

test("loads the Argon model from storage into its popup input", () => {
  const { models } = createPopupMock({ model: "argon-4" });
  assert.equal(models.find((model) => model.value === "argon-4")?.checked, true);
});

test("loads the Carbon model and preserves the popup model order", () => {
  const { models } = createPopupMock({ model: "carbon-4" });
  assert.deepEqual(
    models.map((model) => model.value),
    ["flash-lite-3.5", "flash-3.8", "pro-3.1", "argon-4", "carbon-4"]
  );
  assert.equal(models.find((model) => model.value === "carbon-4")?.checked, true);
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

test("sends the selected thinkingLevel to the worker", async () => {
  const mock = createPopupMock({
    model: "flash-3.8",
    thinkingLevel: "high"
  });

  // User selects "low"
  mock.thinkings.forEach((t) => (t.checked = t.value === "low"));
  mock.panel.trigger("change");

  assert.equal(mock.runtimeSent.length, 1);
  assert.equal(mock.runtimeSent[0].type, "GEMINI_SAVE_SETTINGS");
  assert.equal(mock.runtimeSent[0].settings.thinkingLevel, "low");
  await waitFor(() => mock.status.textContent === "Saved");
});

for (const target of ["medium", "high"]) {
  test(`dispatches ${target} to the worker before the popup closes`, () => {
    const mock = createPopupMock(
      { model: "flash-3.8", thinkingLevel: "low" },
      { deferRuntimeMessages: true }
    );
    mock.thinkings.forEach((item) => (item.checked = item.value === target));
    mock.panel.trigger("change");
    mock.closePopup();

    // The message is issued in the change handler, before popup dismissal can unload it.
    assert.equal(mock.isPopupClosed(), true);
    assert.equal(mock.runtimeSent.length, 1);
    assert.equal(mock.runtimeSent[0].settings.thinkingLevel, target);
  });
}

test("captures rapid changes in order and ignores an older worker response", async () => {
  const mock = createPopupMock(
    { model: "flash-3.8", thinkingLevel: "low" },
    { deferRuntimeMessages: true }
  );

  mock.thinkings.forEach((item) => (item.checked = item.value === "medium"));
  mock.panel.trigger("change");
  mock.thinkings.forEach((item) => (item.checked = item.value === "high"));
  mock.panel.trigger("change");

  assert.deepEqual(
    mock.runtimeSent.map((message) => message.settings.thinkingLevel),
    ["medium", "high"]
  );
  assert.deepEqual(mock.runtimeSent.map((message) => message.sequence), [1, 2]);

  mock.resolveRuntimeMessage(1, { ok: true, saved: true, applied: true });
  await waitFor(() => mock.status.textContent === "Saved");
  mock.resolveRuntimeMessage(0, { ok: false, error: "old request failed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mock.status.textContent, "Saved");
});

test("a late storage read cannot replace a setting changed in the popup", () => {
  const mock = createPopupMock(
    { model: "pro-3.1", thinkingLevel: "low" },
    { deferStorageGet: true, deferRuntimeMessages: true }
  );

  assert.equal(mock.panel.inert, true);
  mock.models.forEach((item) => (item.checked = item.value === "argon-4"));
  mock.thinkings.forEach((item) => (item.checked = item.value === "high"));
  mock.panel.trigger("change");
  mock.finishStorageGet();

  assert.equal(mock.panel.inert, false);
  assert.equal(mock.models.find((item) => item.checked)?.value, "argon-4");
  assert.equal(mock.thinkings.find((item) => item.checked)?.value, "high");
  assert.equal(mock.status.textContent, "Saving…");
  assert.equal(mock.runtimeSent[0].settings.model, "argon-4");
  mock.resolveRuntimeMessage(0, { ok: true, saved: true, applied: true });
});

test("shows a clear status when the worker reports a storage error", async () => {
  const mock = createPopupMock({}, {
    runtimeResponse: { ok: false, saved: false, error: "Could not save the settings." }
  });
  mock.thinkings.forEach((item) => (item.checked = item.value === "medium"));
  mock.panel.trigger("change");

  await waitFor(() => mock.status.textContent === "Could not save the settings.");
  assert.equal(mock.status.dataset.kind, "error");
});

test("shows a clear status when the worker message cannot be sent", async () => {
  const mock = createPopupMock({}, { runtimeMessageError: true });
  mock.thinkings.forEach((item) => (item.checked = item.value === "high"));
  mock.panel.trigger("change");

  await waitFor(() => mock.status.textContent === "Could not save the settings. Try reopening the extension.");
  assert.equal(mock.status.dataset.kind, "error");
});

test("preserves the Gemini link status returned by the worker", async () => {
  const mock = createPopupMock({}, {
    runtimeResponse: {
      ok: false,
      saved: true,
      showGeminiLink: true,
      error: "Saved. Open or refresh Gemini to apply it."
    }
  });
  mock.thinkings.forEach((item) => (item.checked = item.value === "high"));
  mock.panel.trigger("change");

  await waitFor(() => mock.status.children.length === 3);
  assert.equal(mock.status.children[1].textContent, "Gemini");
  assert.equal(mock.status.dataset.kind, "success");
});

test("saves the Argon model and applies it to the active tab", async () => {
  const mock = createPopupMock({
    model: "flash-3.8",
    thinkingLevel: "high"
  });

  mock.models.forEach((model) => (model.checked = model.value === "argon-4"));
  mock.panel.trigger("change");
  await waitFor(() => mock.status.textContent === "Saved");

  assert.equal(mock.runtimeSent[0].settings.model, "argon-4");
});

test("saves the Carbon model and applies it to the active tab", async () => {
  const mock = createPopupMock({
    model: "flash-3.8",
    thinkingLevel: "high"
  });

  mock.models.forEach((model) => (model.checked = model.value === "carbon-4"));
  mock.panel.trigger("change");
  await waitFor(() => mock.status.textContent === "Saved");

  assert.equal(mock.runtimeSent[0].settings.model, "carbon-4");
});
