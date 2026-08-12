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
  let messageListener = null;
  const chrome = {
    runtime: {
      onMessage: {
        addListener(listener) {
          messageListener = listener;
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
        return { ok: true, submitted: true };
      }
    }
  };

  vm.runInContext(
    source,
    vm.createContext({ chrome, setTimeout, clearTimeout })
  );
  return { calls, messageListener };
}

function sendRuntimeMessage(listener, message) {
  return new Promise((resolve) => {
    assert.equal(listener(message, {}, resolve), true);
  });
}

function toPlain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("opens a new active Gemini tab and submits the prompt", async () => {
  const { calls, messageListener } = loadBackground();
  const response = await sendRuntimeMessage(messageListener, {
    type: "GEMINI_FAST_PROMPT_RUN",
    prompt: "Explain this code",
    settings: { model: "pro-3.1", extendedThinking: true }
  });

  assert.deepEqual(toPlain(response), { ok: true, tabId: 42 });
  assert.deepEqual(toPlain(calls[0]), [
    "create",
    { url: "https://gemini.google.com/app", active: true }
  ]);
  assert.deepEqual(toPlain(calls[2]), [
    "sendMessage",
    42,
    {
      type: "GEMINI_FAST_PROMPT_SUBMIT",
      prompt: "Explain this code",
      settings: { model: "pro-3.1", extendedThinking: true }
    }
  ]);
});

test("ignores unrelated runtime messages", () => {
  const { messageListener } = loadBackground();
  assert.equal(messageListener({ type: "OTHER" }, {}, () => {}), false);
});
