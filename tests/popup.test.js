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

const fixtureCatalog = [
  ["flash-lite-3.5", "3.5 Flash-Lite"], ["hydrogen-4", "4 Hydrogen"],
  ["pro-3.1", "3.1 Pro"], ["argon-4", "4 Argon"], ["carbon-4", "4 Carbon"]
].map(([id, label]) => ({ id, label, available: true }));

function createPopupMock(initialStorage = {}, options = {}) {
  let stored = { ...initialStorage };
  const runtimeSent = [];
  const pendingRuntimeResponses = [];
  let pendingStorageGet = null;
  let popupClosed = false;
  const permissionQueries = [];
  const tabCreates = [];
  const models = [];
  const local = { ...options.local };
  let storageListener;

  // Simple DOM simulation
  const elements = {
    "#review-prompt": {
      hidden: true,
      addEventListener(_type, cb) { this.click = cb; },
      contains() { return false; }
    },
    "#review-status": { textContent: "" },
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
    "#model-options": {
      replaceChildren(...rows) {
        models.splice(0, models.length, ...rows.flatMap((row) =>
          row.children.filter((child) => child.name === "model")
        ));
      }
    },
    "#thinking-section": { disabled: false },
    "#thinking-saved": { hidden: true },
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
      local: {
        get(_key, cb) {
          if (cb) return cb({ modelCatalog: options.catalog ?? fixtureCatalog });
          return Promise.resolve({ ...local });
        },
        async set(items) {
          if (options.localWriteError) throw new Error("storage unavailable");
          Object.assign(local, items);
        }
      },
      onChanged: { addListener(cb) { storageListener = cb; } },
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
      query(_filter, cb) { cb(options.tabCatalog ? [{ id: 101 }] : []); },
      sendMessage(_tabId, _message, cb) {
        cb({ catalog: options.tabCatalog, currentModel: options.currentGeminiModel });
      },
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
      return {
        href: "", target: "", rel: "", textContent: "", children: [],
        setAttribute() {},
        append(...children) { this.children.push(...children); }
      };
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
    console,
    Date: options.Date ?? Date
  });

  vm.runInContext(sharedSource, context);
  context.GeminiDefaultModelCore = {
    ...context.GeminiDefaultModelCore,
    REVIEW_PROMPT_DEBUG: options.reviewPromptDebug ?? 0
  };
  vm.runInContext(popupSource, context);

  return {
    getStored: () => stored,
    models,
    thinkings,
    local,
    reviewPrompt: elements["#review-prompt"],
    reviewStatus: elements["#review-status"],
    reviewAction(action) {
      const button = { dataset: { reviewAction: action } };
      return elements["#review-prompt"].click({ target: { closest: () => button } });
    },
    thinkingSection: elements["#thinking-section"],
    changeCatalog(value) { storageListener({ modelCatalog: { newValue: value } }, "local"); },
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

test("shows the review reminder when due and snoozes for exactly one week", async () => {
  const week = 7 * 24 * 60 * 60 * 1000;
  const due = 2 * week;
  let now = due - 1;
  const clock = { now: () => now };
  async function open(local) {
    const mock = createPopupMock({}, { local, Date: clock });
    await new Promise((resolve) => setImmediate(resolve));
    return mock;
  }

  const early = await open({ reviewPromptNextAt: due });
  assert.equal(early.reviewPrompt.hidden, true);
  now = due;
  const duePrompt = await open(early.local);
  assert.equal(duePrompt.reviewPrompt.hidden, false);
  await duePrompt.reviewAction("later");
  assert.equal(duePrompt.reviewPrompt.hidden, true);
  assert.equal(duePrompt.local.reviewPromptNextAt, due + week);
  assert.equal(duePrompt.tabCreates.length, 0);
  now = due + week - 1;
  assert.equal((await open(duePrompt.local)).reviewPrompt.hidden, true);
  now += 1;
  assert.equal((await open(duePrompt.local)).reviewPrompt.hidden, false);
});

test("rating or dismissing permanently hides the review reminder", async () => {
  for (const action of ["rate", "dismiss"]) {
    const mock = createPopupMock({}, { local: { reviewPromptNextAt: 0 } });
    await waitFor(() => !mock.reviewPrompt.hidden);
    await mock.reviewAction(action);
    assert.equal(mock.reviewPrompt.hidden, true);
    assert.equal(mock.local.reviewPromptDismissed, true);
    assert.deepEqual(mock.tabCreates.map(({ url }) => url), action === "rate"
      ? ["https://chromewebstore.google.com/detail/kmklgjnaichjgojddjoecifjhphjgefp/reviews"] : []);

    const reopened = createPopupMock({}, { local: mock.local });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reopened.reviewPrompt.hidden, true);
  }
});

test("keeps the review reminder available if saving the choice fails", async () => {
  const mock = createPopupMock({}, { local: { reviewPromptNextAt: 0 }, localWriteError: true });
  await waitFor(() => !mock.reviewPrompt.hidden);
  await mock.reviewAction("rate");
  assert.equal(mock.reviewPrompt.hidden, false);
  assert.equal(mock.reviewStatus.textContent, "Could not save your choice. Try again.");
  assert.equal(mock.tabCreates.length, 0);
});

test("debug review prompt shows immediately and supports clicks without saving choices", async () => {
  const local = { reviewPromptNextAt: Date.now() + 60_000, reviewPromptDismissed: true };
  for (const action of ["later", "dismiss", "rate"]) {
    const mock = createPopupMock({}, { local, reviewPromptDebug: 1, localWriteError: true });
    assert.equal(mock.reviewPrompt.hidden, false);
    await mock.reviewAction(action);
    assert.equal(mock.reviewPrompt.hidden, true);
    assert.deepEqual(mock.local, local);
    assert.equal(mock.tabCreates.length, action === "rate" ? 1 : 0);
  }
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("popup operation did not complete in time");
}

test("removes a disappeared model from the popup and selects an available alternative", () => {
  const mock = createPopupMock({ model: "mode:future", thinkingLevel: "medium" }, { catalog: [] });
  assert.deepEqual(mock.models, []);
  mock.changeCatalog([
    { id: "auto", label: "Auto", available: true },
    { id: "mode:future", label: "4 Neon", available: true },
    { id: "carbon-4", label: "4 Carbon", available: false }
  ]);
  assert.equal(mock.models.find((item) => item.checked)?.value, "mode:future");
  assert.equal(mock.models.find((item) => item.value === "carbon-4").disabled, true);
  mock.changeCatalog([
    { id: "carbon-4", label: "4 Carbon", available: false },
    { id: "auto", label: "Auto", available: true }
  ]);
  assert.equal(mock.models.some((item) => item.value === "mode:future"), false);
  assert.equal(mock.models.find((item) => item.checked)?.value, "auto");
  assert.equal(mock.thinkingSection.disabled, true);
  assert.equal(mock.thinkings.find((item) => item.checked)?.value, "medium");
  assert.equal(mock.runtimeSent.length, 0);
});

test("prefers Gemini's current available model when the saved model disappeared", () => {
  const mock = createPopupMock({ model: "mode:removed", thinkingLevel: "medium" }, {
    tabCatalog: [{ id: "auto", label: "Auto", available: true }, ...fixtureCatalog],
    currentGeminiModel: "hydrogen-4"
  });
  assert.equal(mock.models.find((item) => item.checked)?.value, "hydrogen-4");
  assert.equal(mock.thinkingSection.disabled, false);
  assert.equal(mock.thinkings.find((item) => item.checked)?.value, "medium");
});

test("disables thinking on Auto and preserves the saved level when leaving Auto", () => {
  const mock = createPopupMock({ model: "auto", thinkingLevel: "medium" }, {
    catalog: [{ id: "auto", label: "Auto", available: true }, ...fixtureCatalog]
  });
  assert.equal(mock.thinkingSection.disabled, true);
  mock.models.forEach((item) => (item.checked = item.value === "hydrogen-4"));
  mock.panel.trigger("change");
  assert.equal(mock.thinkingSection.disabled, false);
  assert.equal(mock.runtimeSent[0].settings.model, "hydrogen-4");
  assert.equal(mock.runtimeSent[0].settings.thinkingLevel, "medium");
});

test("prefers availability from the active Gemini tab over another account's cache", () => {
  const available = { id: "carbon-4", label: "4 Carbon", available: true };
  const mock = createPopupMock({ model: "carbon-4" }, {
    catalog: [{ ...available, available: false }],
    tabCatalog: [available]
  });
  assert.equal(mock.models.find((item) => item.value === "carbon-4").disabled, false);
  mock.changeCatalog([{ ...available, available: false }]);
  assert.equal(mock.models.find((item) => item.value === "carbon-4").disabled, false);
});

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
    ["flash-lite-3.5", "hydrogen-4", "pro-3.1", "argon-4", "carbon-4"]
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
  assert.equal(mock.models.find((item) => item.checked).value, "hydrogen-4");
});

test("shows Hydrogen for saved Flash preferences without exposing legacy models", () => {
  for (const model of ["flash-3.6", "flash-3.7", "flash-3.8", "hydrogen-4"]) {
    const mock = createPopupMock({ model, thinkingLevel: "medium" });
    assert.equal(mock.models.find((item) => item.checked)?.value, "hydrogen-4");
    assert.equal(mock.models.some((item) => ["flash-3.7", "flash-3.8"].includes(item.value)), false);
    assert.equal(mock.thinkings.find((item) => item.checked)?.value, "medium");
  }
});

test("saves Hydrogen when selected in the popup", async () => {
  const mock = createPopupMock({ model: "argon-4", thinkingLevel: "medium" });
  mock.models.forEach((item) => (item.checked = item.value === "hydrogen-4"));
  mock.panel.trigger("change");
  await waitFor(() => mock.status.textContent === "Saved");
  assert.equal(mock.runtimeSent[0].settings.model, "hydrogen-4");
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
