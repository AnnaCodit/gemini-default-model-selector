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
    core.inferPickerState("Open mode picker, currently 3.8 Flash Extended")
      .model,
    "flash-3.8"
  );
  assert.equal(
    core.inferPickerState("Open mode picker, currently 3.7 Flash Extended")
      .model,
    "flash-3.7"
  );
  assert.equal(
    core.inferPickerState("Open mode picker, currently Pro").model,
    "pro-3.1"
  );
  assert.equal(
    core.inferPickerState("Open mode picker, currently Flash Extended").model,
    "flash-3.8"
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

test("migrates the former Flash model settings", () => {
  assert.deepEqual(
    {
      ...core.normalizeSettings({
        model: "flash-3.6",
        extendedThinking: false
      })
    },
    { model: "flash-3.8", extendedThinking: false }
  );
  assert.deepEqual(
    {
      ...core.normalizeSettings({
        model: "flash-3.7",
        extendedThinking: false
      })
    },
    { model: "flash-3.8", extendedThinking: false }
  );
});

test("resolves model with fallback when the newer model is not yet rolled out", () => {
  const availableWithout38 = new Set(["3.5 Flash-Lite", "3.7 Flash", "3.1 Pro"]);
  const availableWith38 = new Set([
    "3.5 Flash-Lite",
    "3.8 Flash",
    "3.1 Pro"
  ]);

  const resolvedFallback = core.resolveModelWithFallback("flash-3.8", (model) =>
    availableWithout38.has(model.menuPrefix)
  );
  assert.equal(resolvedFallback?.id, "flash-3.7");

  const resolvedDirect = core.resolveModelWithFallback("flash-3.8", (model) =>
    availableWith38.has(model.menuPrefix)
  );
  assert.equal(resolvedDirect?.id, "flash-3.8");
});

test("finds the thinking option independently of its language", () => {
  const russianOptions = [
    { text: "3.5 Flash-Lite Самые быстрые ответы" },
    { text: "3.7 Flash All-around help" },
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
      { text: "3.7 Flash All-around help" },
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
