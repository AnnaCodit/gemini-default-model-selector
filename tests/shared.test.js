const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "shared.js"),
  "utf8"
);
const context = vm.createContext({});
vm.runInContext(source, context);
const core = context.GeminiDefaultModelCore;

test("normalizes valid settings", () => {
  assert.deepEqual(
    { ...core.normalizeSettings({ model: "pro-3.1", extendedThinking: false }) },
    { model: "pro-3.1", extendedThinking: false }
  );
});

test("falls back to defaults for invalid settings", () => {
  assert.deepEqual(
    { ...core.normalizeSettings({ model: "unknown", extendedThinking: "yes" }) },
    { ...core.DEFAULT_SETTINGS }
  );
});

test("infers every Gemini model from picker text", () => {
  assert.equal(
    core.inferPickerState("Open mode picker, currently Flash-Lite").model,
    "flash-lite-3.5"
  );
  assert.equal(
    core.inferPickerState("Open mode picker, currently Flash Extended").model,
    "flash-3.6"
  );
  assert.equal(
    core.inferPickerState("Open mode picker, currently Pro").model,
    "pro-3.1"
  );
  assert.equal(
    core.inferPickerState(
      "Выбор режима, сейчас используется Flash-Lite Расширенный"
    ).model,
    "flash-lite-3.5"
  );
});

test("infers Extended thinking state", () => {
  assert.equal(
    core.inferPickerState("Open mode picker, currently Flash Extended")
      .extendedThinking,
    true
  );
  assert.equal(
    core.inferPickerState("Open mode picker, currently Flash").extendedThinking,
    false
  );
});

test("finds the thinking option independently of its language", () => {
  const russianOptions = [
    { text: "3.5 Flash-Lite Самые быстрые ответы" },
    { text: "3.6 Flash All-around help" },
    { text: "3.1 Pro Advanced math & code" },
    {
      text: "Расширенные способности к размышлениям Решение сложных проблем",
      followsSeparator: true
    }
  ];

  assert.equal(core.findExtendedOptionIndex(russianOptions), 3);
  assert.equal(
    core.findExtendedOptionIndex([
      { text: "3.5 Flash-Lite Fastest answers" },
      { text: "3.6 Flash All-around help" },
      { text: "3.1 Pro Advanced math & code" },
      { text: "Extended thinking Complex problem solving" }
    ]),
    3
  );
});

test("reads thinking state from the picker structure, not localized text", () => {
  const russianLabel =
    "Выбор режима, сейчас используется Flash-Lite Расширенный";

  assert.equal(
    core.resolvePickerState(russianLabel, true).extendedThinking,
    true
  );
  assert.equal(
    core.resolvePickerState(russianLabel, false).extendedThinking,
    false
  );
});
