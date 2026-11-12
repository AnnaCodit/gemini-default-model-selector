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
  let commandListener = null;
  let messageListener = null;
  const storageWriteReleases = [];
  const applyReleases = [];
  const chrome = {
    commands: {
      onCommand: {
        addListener(listener) {
          commandListener = listener;
        }
      }
    },
    runtime: {
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
      sync: {
        async get(keys) {
          calls.push(["storageGet", keys]);
          return Object.fromEntries(keys.filter((key) => key in currentStored)
            .map((key) => [key, currentStored[key]]));
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

  const context = vm.createContext({ chrome, console, setTimeout, clearTimeout });
  context.importScripts = (name) => {
    assert.equal(name, "shared.js");
    vm.runInContext(sharedSource, context);
  };
  vm.runInContext(source, context);
  return {
    calls,
    commandListener,
    messageListener,
    getStored: () => currentStored,
    setActiveTab(tabId) { activeTabId = tabId; },
    releaseStorageWrite(index) { storageWriteReleases[index]?.(); },
    releaseApply(index, result = { ok: true, applied: true }) {
      applyReleases[index]?.(result);
    }
  };
}

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

test("reports storage failures without attempting an apply", async () => {
  const mock = loadBackground({}, { storageSetError: "storage unavailable" });
  const response = await sendRuntimeMessage(mock.messageListener, {
    type: "GEMINI_SAVE_SETTINGS",
    settings: { model: "flash-3.8", thinkingLevel: "high" }
  });

  assert.deepEqual(toPlain(response), {
    ok: false, saved: false, error: "Could not save the settings."
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
  assert.equal(response.error, "Saved. Open or refresh Gemini to apply it.");
  assert.equal(mock.getStored().thinkingLevel, "high");
});

