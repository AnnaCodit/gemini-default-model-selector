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

test("normalizes valid settings with thinkingLevel", () => {
  assert.deepEqual(
    { ...core.normalizeSettings({ model: "pro-3.1", thinkingLevel: "medium" }) },
    { model: "pro-3.1", thinkingLevel: "medium", extendedThinking: true }
  );
  assert.deepEqual(
    { ...core.normalizeSettings({ model: "pro-3.1", thinkingLevel: "low" }) },
    { model: "pro-3.1", thinkingLevel: "low", extendedThinking: false }
  );
  assert.deepEqual(
    { ...core.normalizeSettings({ model: "argon-4", thinkingLevel: "medium" }) },
    { model: "argon-4", thinkingLevel: "medium", extendedThinking: true }
  );
});

test("migrates legacy extendedThinking boolean to thinkingLevel", () => {
  assert.deepEqual(
    { ...core.normalizeSettings({ model: "flash-3.8", extendedThinking: false }) },
    { model: "flash-3.8", thinkingLevel: "low", extendedThinking: false }
  );
  assert.deepEqual(
    { ...core.normalizeSettings({ model: "flash-3.8", extendedThinking: true }) },
    { model: "flash-3.8", thinkingLevel: "high", extendedThinking: true }
  );
});

test("falls back to defaults for invalid settings", () => {
  assert.deepEqual(
    { ...core.normalizeSettings({ model: "unknown", thinkingLevel: "invalid" }) },
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
    core.inferPickerState("Open mode picker, currently 4 Argon").model,
    "argon-4"
  );
  assert.equal(core.inferPickerState("Argon").model, "argon-4");
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

test("does not infer thinking levels from localized picker labels", () => {
  for (const label of ["High", "Medium", "Low", "Средний", "高"]) {
    assert.deepEqual({ ...core.inferPickerState(`Flash ${label}`) }, { model: "flash-3.8" });
  }
});

test("a valid thinkingLevel overrides a stale legacy boolean", () => {
  assert.equal(core.normalizeSettings({ thinkingLevel: "low", extendedThinking: true }).extendedThinking, false);
  assert.equal(core.normalizeSettings({ thinkingLevel: "medium", extendedThinking: false }).extendedThinking, true);
});

test("migrates the former Flash model settings", () => {
  assert.deepEqual(
    {
      ...core.normalizeSettings({
        model: "flash-3.6",
        extendedThinking: false
      })
    },
    { model: "flash-3.8", thinkingLevel: "low", extendedThinking: false }
  );
  assert.deepEqual(
    {
      ...core.normalizeSettings({
        model: "flash-3.7",
        thinkingLevel: "high"
      })
    },
    { model: "flash-3.8", thinkingLevel: "high", extendedThinking: true }
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

test("finds thinking options independently of language in new 3-option UI", () => {
  const russianOptions = [
    { text: "3.5 Flash-Lite Самые быстрые ответы" },
    { text: "3.8 Flash All-around help" },
    { text: "3.1 Pro Advanced reasoning" },
    { text: "Низкая Быстро и эффективно", followsSeparator: true },
    { text: "Средний Сбалансированная глубина" },
    { text: "Высокая Максимально тщательно" }
  ];

  assert.equal(core.findThinkingOptionIndex(russianOptions, "low"), 3);
  assert.equal(core.findThinkingOptionIndex(russianOptions, "medium"), 4);
  assert.equal(core.findThinkingOptionIndex(russianOptions, "high"), 5);
});

test("finds legacy single thinking option when only one option exists", () => {
  const legacyRussian = [
    { text: "3.5 Flash-Lite Самые быстрые ответы" },
    { text: "3.7 Flash All-around help" },
    { text: "3.1 Pro Advanced math & code" },
    {
      text: "Расширенные способности к размышлениям Решение сложных проблем",
      followsSeparator: true
    }
  ];

  assert.equal(core.findThinkingOptionIndex(legacyRussian, "high"), 3);
  assert.equal(core.findThinkingOptionIndex(legacyRussian, "low"), 3);
  assert.equal(core.findExtendedOptionIndex(legacyRussian), 3);
});

test("detects the new UI without a separator", () => {
  const options = [
    { text: "3.8 Flash" }, { text: "α" }, { text: "β" }, { text: "γ" }
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(core.findThinkingOptions(options))), {
    kind: "levels", indexes: [1, 2, 3]
  });
  assert.equal(core.findThinkingOptionIndex(options, "low"), 1);
});

test("prefers three radio options when a legacy checkbox is also present", () => {
  const options = [
    { text: "3.8 Flash", isModel: true }, { text: "Old toggle" },
    { text: "α", isRadio: true }, { text: "β", isRadio: true }, { text: "γ", isRadio: true }
  ];
  assert.equal(core.findThinkingOptionIndex(options, "medium"), 3);
});

test("ignores submenu triggers when looking for thinking options", () => {
  const modelMenu = [
    { text: "3.5 Flash-Lite", isModel: true },
    { text: "3.8 Flash", isModel: true },
    { text: "4 Argon", isModel: true },
    { text: "3.1 Pro", isModel: true },
    { text: "More models", isSubmenu: true }
  ];
  assert.equal(core.findThinkingOptions(modelMenu), null);

  const optionsWithLevels = [
    { text: "3.8 Flash", isModel: true },
    { text: "Thinking levels", isSubmenu: true },
    { text: "α", isRadio: true },
    { text: "β", isRadio: true },
    { text: "γ", isRadio: true }
  ];
  assert.deepEqual(
    JSON.parse(JSON.stringify(core.findThinkingOptions(optionsWithLevels))),
    { kind: "levels", indexes: [2, 3, 4] }
  );
});

test("rejects incomplete or ambiguous thinking groups", () => {
  assert.equal(core.findThinkingOptions([{ text: "α", isRadio: true }]), null);
  assert.equal(core.findThinkingOptions([{ text: "α" }, { text: "β" }]), null);
  assert.equal(core.findThinkingOptions(Array.from({ length: 4 }, (_, i) => ({ text: String(i) }))), null);
  assert.equal(core.findThinkingOptionIndex([{ text: "α" }], "unknown"), -1);
});
