const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "background.js"),
  "utf8"
);
const sharedSource = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf8");

function loadBackground(
  stored = { model: "pro-3.1", extendedThinking: false },
  options = {}
) {
  const calls = [];
  let currentStored = { ...stored };
  let activeTabId = options.activeTabId ?? 101;
  let remainingInitialSendFailures = options.initialSendFailures || 0;
  let commandListener = null;
  let messageListener = null;
  let installedListener = null;
  const local = { ...options.local };
  const storageWriteReleases = [];
  const storageReadReleases = [];
  const applyReleases = [];
  let storageReadCount = 0;
  const chrome = {
    commands: {
      onCommand: {
        addListener(listener) {
          commandListener = listener;
        }
      }
    },
    runtime: {
      onInstalled: {
        addListener(listener) { installedListener = listener; }
      },
      onUpdateAvailable: {
        addListener() {}
      },
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        }
      }
    },
    storage: {
      local: {
        async get(key) { return { [key]: local[key] }; },
        async set(items) { Object.assign(local, items); }
      },
      sync: {
        async get(keys) {
          const snapshot = { ...currentStored };
          const readIndex = storageReadCount++;
          calls.push(["storageGet", keys]);
          if (readIndex < (options.deferStorageReads || 0)) {
            await new Promise((resolve) => storageReadReleases.push(resolve));
          }
          return Object.fromEntries(keys.filter((key) => key in snapshot)
            .map((key) => [key, snapshot[key]]));
        },
        async set(items) {
          calls.push(["storageSet", { ...items }]);
          if (options.deferStorageWrites) {
            await new Promise((resolve) => storageWriteReleases.push(resolve));
          }
          if (options.storageSetError) {
            throw new Error(options.storageSetError);
          }
          currentStored = { ...currentStored, ...items };
        }
      }
    },
    tabs: {
      async create(options) {
        calls.push(["create", options]);
        return { id: 42, windowId: 7 };
      },
      async get(tabId) {
        calls.push(["get", tabId]);
        return { id: tabId };
      },
      async query(queryOptions) {
        calls.push(["query", queryOptions]);
        return options.noActiveTab ? [] : [{ id: activeTabId }];
      },
      async sendMessage(tabId, message) {
        calls.push(["sendMessage", tabId, message]);
        if (message?.initialApplication && remainingInitialSendFailures > 0) {
          remainingInitialSendFailures -= 1;
          throw new Error("content script unavailable");
        }
        if (options.sendMessageError) {
          throw new Error(options.sendMessageError);
        }
        if (options.deferApplyMessages) {
          return new Promise((resolve) => applyReleases.push(resolve));
        }
        return options.applyResult || { ok: true, applied: true };
      }
    }
  };

  const context = vm.createContext({
    chrome, console, setTimeout, clearTimeout, Date: options.Date ?? Date
  });
  context.importScripts = (name) => {
    assert.equal(name, "shared.js");
    vm.runInContext(sharedSource, context);
  };
  vm.runInContext(source, context);
  return {
    calls,
    commandListener,
    messageListener,
    installedListener,
    local,
    getStored: () => currentStored,
    setActiveTab(tabId) { activeTabId = tabId; },
    releaseStorageRead(index) { storageReadReleases[index]?.(); },
    releaseStorageWrite(index) { storageWriteReleases[index]?.(); },
    releaseApply(index, result = { ok: true, applied: true }) {
      applyReleases[index]?.(result);
    }
  };
}

test("schedules a review two weeks after installation or the first update with the reminder", async () => {
  const day = 24 * 60 * 60 * 1000;
  let now = 30 * day;
  for (const reason of ["install", "update"]) {
    const mock = loadBackground({}, { Date: { now: () => now } });
    await mock.installedListener({ reason: "chrome_update" });
    assert.equal(mock.local.reviewPromptNextAt, undefined);
    const firstPrompt = now + 14 * day;
    await mock.installedListener({ reason });
    assert.equal(mock.local.reviewPromptNextAt, firstPrompt);
    now += day;
    await mock.installedListener({ reason: "update" });
    assert.equal(mock.local.reviewPromptNextAt, firstPrompt);
  }
});

function sendRuntimeMessage(listener, message) {
  return new Promise((resolve) => {
    assert.equal(listener(message, {}, resolve), true);
  });
}

function toPlain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("background operation did not complete in time");
}

test("opens a new active Gemini tab and focuses its composer", async () => {
  const { calls, messageListener } = loadBackground();
  const response = await sendRuntimeMessage(messageListener, {
    type: "GEMINI_OPEN_NEW_TAB"
  });

  assert.deepEqual(toPlain(response), { ok: true, tabId: 42 });
  assert.deepEqual(toPlain(calls[0]), [
    "create",
    { url: "https://gemini.google.com/app", active: true }
  ]);
  assert.deepEqual(toPlain(calls[3]), [
    "sendMessage",
    42,
    {
      type: "GEMINI_DEFAULT_MODEL_APPLY",
      settings: { model: "pro-3.1", thinkingLevel: "low", extendedThinking: false },
      focusComposer: true,
      waitForUi: true,
      initialApplication: true
    }
  ]);
});

test("opens Gemini when the keyboard command runs", async () => {
  const { calls, commandListener } = loadBackground();
  await commandListener("open-gemini");

  assert.equal(calls.filter(([name]) => name === "create").length, 1);
  assert.equal(calls.filter(([name]) => name === "sendMessage").length, 1);
});

test("ignores unrelated commands and runtime messages", () => {
  const { calls, commandListener, messageListener } = loadBackground();

  assert.equal(commandListener("other-command"), undefined);
  assert.equal(messageListener({ type: "OTHER" }, {}, () => {}), false);
  assert.equal(calls.length, 0);
});

test("reads raw storage keys before migration", async () => {
  const { calls, messageListener } = loadBackground();
  await sendRuntimeMessage(messageListener, {
    type: "GEMINI_OPEN_NEW_TAB"
  });

  const storageCall = calls.find(([name]) => name === "storageGet");
  assert.deepEqual(toPlain(storageCall[1]), ["model", "thinkingLevel", "extendedThinking"]);
});

test("opens Gemini with defaults when storage is empty", async () => {
  const { calls, messageListener } = loadBackground({});
  await sendRuntimeMessage(messageListener, { type: "GEMINI_OPEN_NEW_TAB" });
  const settings = calls.find(([name]) => name === "sendMessage")[2].settings;
  assert.deepEqual(toPlain(settings), { model: "hydrogen-4", thinkingLevel: "high", extendedThinking: true });
});

test("saves normalized popup settings and applies them to the active tab", async () => {
  const mock = loadBackground({});
  const response = await sendRuntimeMessage(mock.messageListener, {
    type: "GEMINI_SAVE_SETTINGS",
    settings: { model: "flash-3.8", thinkingLevel: "medium", extendedThinking: false }
  });

  assert.deepEqual(toPlain(response), { ok: true, applied: true, saved: true });
  assert.deepEqual(toPlain(mock.getStored()), {
    model: "hydrogen-4", thinkingLevel: "medium", extendedThinking: true
  });
  const applied = mock.calls.find(([name]) => name === "sendMessage");
  assert.equal(applied[1], 101);
  assert.deepEqual(toPlain(applied[2].settings), toPlain(mock.getStored()));
  assert.equal(applied[2].focusComposer, true);
});

test("uses the tab that was active when the popup save was received", async () => {
  const mock = loadBackground({}, { deferStorageWrites: true });
  const save = sendRuntimeMessage(mock.messageListener, {
    type: "GEMINI_SAVE_SETTINGS",
    settings: { model: "flash-3.8", thinkingLevel: "medium" }
  });
  await waitFor(() => mock.calls.some(([name]) => name === "query"));
  await waitFor(() => mock.calls.some(([name]) => name === "storageSet"));
  mock.setActiveTab(202);
  mock.releaseStorageWrite(0);
  await save;

  const applied = mock.calls.find(([name]) => name === "sendMessage");
  assert.equal(applied[1], 101);
});

test("skips an apply superseded while its storage write is pending", async () => {
  const mock = loadBackground({}, { deferStorageWrites: true });
  const medium = sendRuntimeMessage(mock.messageListener, {
    type: "GEMINI_SAVE_SETTINGS",
    settings: { model: "flash-3.8", thinkingLevel: "medium" }
  });
  const high = sendRuntimeMessage(mock.messageListener, {
    type: "GEMINI_SAVE_SETTINGS",
    settings: { model: "flash-3.8", thinkingLevel: "high" }
  });

  await waitFor(() => mock.calls.filter(([name]) => name === "storageSet").length === 1);
  assert.deepEqual(
    mock.calls.filter(([name]) => name === "storageSet").map(([, settings]) => settings.thinkingLevel),
    ["medium"]
  );
  mock.releaseStorageWrite(0);
  await waitFor(() => mock.calls.filter(([name]) => name === "storageSet").length === 2);
  assert.equal(mock.calls.some(([name]) => name === "sendMessage"), false);

  mock.releaseStorageWrite(1);
  const [mediumResponse, highResponse] = await Promise.all([medium, high]);
  assert.equal(mediumResponse.stale, true);
  assert.equal(highResponse.applied, true);
  assert.deepEqual(
    mock.calls.filter(([name]) => name === "storageSet").map(([, settings]) => settings.thinkingLevel),
    ["medium", "high"]
  );
  const applied = mock.calls.filter(([name]) => name === "sendMessage");
  assert.deepEqual(applied.map(([, , message]) => message.settings.thinkingLevel), ["high"]);
  assert.equal(mock.getStored().thinkingLevel, "high");
});

test("later settings save while an earlier tab apply is still pending", async () => {
  const mock = loadBackground({}, { deferApplyMessages: true });
  const medium = sendRuntimeMessage(mock.messageListener, {
    type: "GEMINI_SAVE_SETTINGS",
    settings: { model: "flash-3.8", thinkingLevel: "medium" }
  });
  await waitFor(() => mock.calls.some(([name]) => name === "sendMessage"));

  const high = sendRuntimeMessage(mock.messageListener, {
    type: "GEMINI_SAVE_SETTINGS",
    settings: { model: "flash-3.8", thinkingLevel: "high" }
  });
  await waitFor(() => mock.calls.filter(([name]) => name === "storageSet").length === 2);
  await waitFor(() => mock.calls.filter(([name]) => name === "sendMessage").length === 2);

  assert.deepEqual(
    mock.calls.filter(([name]) => name === "storageSet").map(([, settings]) => settings.thinkingLevel),
    ["medium", "high"]
  );
  assert.equal(mock.getStored().thinkingLevel, "high");
  assert.deepEqual(
    mock.calls.filter(([name]) => name === "sendMessage")
      .map(([, , message]) => message.settings.thinkingLevel),
    ["medium", "high"]
  );

  mock.releaseApply(0);
  mock.releaseApply(1);
  const [mediumResponse, highResponse] = await Promise.all([medium, high]);
  assert.equal(mediumResponse.stale, true);
  assert.equal(highResponse.applied, true);
});

test("finishes worker save and apply after the popup has closed", async () => {
  const mock = loadBackground({}, { deferStorageWrites: true });
  let popupOpen = true;
  let popupResponse = null;
  const keepChannelOpen = mock.messageListener({
    type: "GEMINI_SAVE_SETTINGS",
    settings: { model: "flash-3.8", thinkingLevel: "high" }
  }, {}, (response) => {
    if (popupOpen) popupResponse = response;
  });

  assert.equal(keepChannelOpen, true);
  await waitFor(() => mock.calls.some(([name]) => name === "storageSet"));
  popupOpen = false;
  mock.releaseStorageWrite(0);
  await waitFor(() => mock.calls.some(([name]) => name === "sendMessage"));

  assert.equal(mock.getStored().thinkingLevel, "high");
  assert.equal(mock.calls.some(([name]) => name === "sendMessage"), true);
  assert.equal(popupResponse, null);
});

test("openGemini waits for pending popup writes before reading storage", async () => {
  const mock = loadBackground({}, { deferStorageWrites: true });
  const save = sendRuntimeMessage(mock.messageListener, {
    type: "GEMINI_SAVE_SETTINGS",
    settings: { model: "argon-4", thinkingLevel: "medium" }
  });
  await waitFor(() => mock.calls.some(([name]) => name === "storageSet"));

  const open = sendRuntimeMessage(mock.messageListener, { type: "GEMINI_OPEN_NEW_TAB" });
  await waitFor(() => mock.calls.some(([name]) => name === "create"));
  assert.equal(mock.calls.some(([name]) => name === "storageGet"), false);

  mock.releaseStorageWrite(0);
  await Promise.all([save, open]);
  const storageReadIndex = mock.calls.findIndex(([name]) => name === "storageGet");
  const storageWriteIndex = mock.calls.findIndex(([name]) => name === "storageSet");
  const newTabApply = mock.calls.find(([, tabId, message]) =>
    tabId === 42 && message?.initialApplication === true
  );
  assert(storageReadIndex > storageWriteIndex);
  assert.deepEqual(toPlain(newTabApply[2].settings), {
    model: "argon-4", thinkingLevel: "medium", extendedThinking: true
  });
});

test("openGemini rereads settings when a popup save starts during storage read", async () => {
  const mock = loadBackground(
    { model: "argon-4", thinkingLevel: "low" },
    { deferStorageReads: 1, deferStorageWrites: true }
  );
  const open = sendRuntimeMessage(mock.messageListener, { type: "GEMINI_OPEN_NEW_TAB" });
  await waitFor(() => mock.calls.some(([name]) => name === "storageGet"));

  mock.setActiveTab(42);
  const save = sendRuntimeMessage(mock.messageListener, {
    type: "GEMINI_SAVE_SETTINGS",
    settings: { model: "carbon-4", thinkingLevel: "medium" }
  });
  await waitFor(() => mock.calls.some(([name]) => name === "storageSet"));

  mock.releaseStorageRead(0);
  mock.releaseStorageWrite(0);
  await waitFor(() => mock.calls.filter(([name]) => name === "storageGet").length === 2);
  const [openResponse, saveResponse] = await Promise.all([open, save]);

  assert.deepEqual(toPlain(openResponse), { ok: true, tabId: 42 });
  assert.equal(saveResponse.applied, true);
  const newTabApply = mock.calls.find(([, tabId, message]) =>
    tabId === 42 && message?.initialApplication === true
  );
  assert.deepEqual(toPlain(newTabApply[2].settings), {
    model: "carbon-4", thinkingLevel: "medium", extendedThinking: true
  });
});

test("openGemini refreshes settings before retrying a pending tab connection", async () => {
  const mock = loadBackground(
    { model: "argon-4", thinkingLevel: "low" },
    { initialSendFailures: 1 }
  );
  const open = sendRuntimeMessage(mock.messageListener, { type: "GEMINI_OPEN_NEW_TAB" });
  await waitFor(() => mock.calls.some(([, , message]) =>
    message?.initialApplication === true
  ));

  mock.setActiveTab(42);
  const save = sendRuntimeMessage(mock.messageListener, {
    type: "GEMINI_SAVE_SETTINGS",
    settings: { model: "carbon-4", thinkingLevel: "medium" }
  });
  const [openResponse, saveResponse] = await Promise.all([open, save]);

  assert.deepEqual(toPlain(openResponse), { ok: true, tabId: 42 });
  assert.equal(saveResponse.applied, true);
  const initialApplies = mock.calls.filter(([, , message]) =>
    message?.initialApplication === true
  );
  assert.equal(initialApplies.length, 2);
  assert.deepEqual(toPlain(initialApplies[0][2].settings), {
    model: "argon-4", thinkingLevel: "low", extendedThinking: false
  });
  assert.deepEqual(toPlain(initialApplies[1][2].settings), {
    model: "carbon-4", thinkingLevel: "medium", extendedThinking: true
  });
});

test("reports storage failures without attempting an apply", async () => {
  const mock = loadBackground({}, { storageSetError: "storage unavailable" });
  const response = await sendRuntimeMessage(mock.messageListener, {
    type: "GEMINI_SAVE_SETTINGS",
    settings: { model: "flash-3.8", thinkingLevel: "high" }
  });

  assert.deepEqual(toPlain(response), {
    ok: false, saved: false, messageKey: "popup_save_failed"
  });
  assert.equal(mock.calls.some(([name]) => name === "sendMessage"), false);
});

test("returns the refresh link when active-tab messaging fails", async () => {
  const mock = loadBackground({}, { sendMessageError: "content script unavailable" });
  const response = await sendRuntimeMessage(mock.messageListener, {
    type: "GEMINI_SAVE_SETTINGS",
    settings: { model: "flash-3.8", thinkingLevel: "high" }
  });

  assert.equal(response.ok, false);
  assert.equal(response.saved, true);
  assert.equal(response.showGeminiLink, true);
  assert.equal(mock.getStored().thinkingLevel, "high");
});

test("forwards the Gemini failure code and model name to the popup", async () => {
  const failure = {
    ok: false, messageKey: "popup_apply_model_unavailable", substitution: "4 Carbon"
  };
  const mock = loadBackground({}, { applyResult: failure });

  const saved = await sendRuntimeMessage(mock.messageListener, {
    type: "GEMINI_SAVE_SETTINGS",
    settings: { model: "carbon-4", thinkingLevel: "medium" }
  });
  assert.deepEqual(toPlain(saved), { ...failure, saved: true });

  const opened = await sendRuntimeMessage(mock.messageListener, { type: "GEMINI_OPEN_NEW_TAB" });
  assert.deepEqual(toPlain(opened), failure);
});

