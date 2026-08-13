const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "background.js"),
  "utf8"
);

function loadBackground() {
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
        async get(defaults) {
          calls.push(["storageGet", defaults]);
          return { model: "pro-3.1", extendedThinking: false };
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

  vm.runInContext(
    source,
    vm.createContext({ chrome, console, setTimeout, clearTimeout })
  );
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
      settings: { model: "pro-3.1", extendedThinking: false },
      focusComposer: true,
      waitForUi: true
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
