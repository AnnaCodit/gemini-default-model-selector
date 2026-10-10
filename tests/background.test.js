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

function loadBackground(stored = { model: "pro-3.1", extendedThinking: false }) {
  const calls = [];
  let commandListener = null;
  let messageListener = null;
  const chrome = {
    commands: {
      onCommand: {
        addListener(listener) {
          commandListener = listener;
        }
      }
    },
    runtime: {
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
          return Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, stored[key]]));
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
      async sendMessage(tabId, message) {
        calls.push(["sendMessage", tabId, message]);
        return { ok: true, applied: true };
      }
    }
  };

  const context = vm.createContext({ chrome, console, setTimeout, clearTimeout });
  context.importScripts = (name) => {
    assert.equal(name, "shared.js");
    vm.runInContext(sharedSource, context);
  };
  vm.runInContext(source, context);
  return { calls, commandListener, messageListener };
}

function sendRuntimeMessage(listener, message) {
  return new Promise((resolve) => {
    assert.equal(listener(message, {}, resolve), true);
  });
}

function toPlain(value) {
  return JSON.parse(JSON.stringify(value));
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
  assert.deepEqual(toPlain(settings), { model: "flash-3.8", thinkingLevel: "high", extendedThinking: true });
});

