(function initializeSharedApi(globalScope) {
  "use strict";

  const MODEL_OPTIONS = Object.freeze([
    Object.freeze({
      id: "flash-lite-3.5",
      label: "3.5 Flash-Lite",
      description: "Fastest answers",
      menuPrefix: "3.5 Flash-Lite"
    }),
    Object.freeze({
      id: "flash-3.6",
      label: "3.6 Flash",
      description: "All-around help",
      menuPrefix: "3.6 Flash"
    }),
    Object.freeze({
      id: "pro-3.1",
      label: "3.1 Pro",
      description: "Advanced math and code",
      menuPrefix: "3.1 Pro"
    })
  ]);

  const DEFAULT_SETTINGS = Object.freeze({
    model: "flash-3.6",
    extendedThinking: true
  });

  const MODEL_IDS = new Set(MODEL_OPTIONS.map((model) => model.id));

  function normalizeSettings(value) {
    const candidate = value && typeof value === "object" ? value : {};

    return {
      model: MODEL_IDS.has(candidate.model)
        ? candidate.model
        : DEFAULT_SETTINGS.model,
      extendedThinking:
        typeof candidate.extendedThinking === "boolean"
          ? candidate.extendedThinking
          : DEFAULT_SETTINGS.extendedThinking
    };
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function inferPickerState(value) {
    const text = normalizeText(value).toLocaleLowerCase("en-US");
    let model = null;

    if (text.includes("flash-lite") || text.includes("3.5 flash")) {
      model = "flash-lite-3.5";
    } else if (text.includes("pro") || text.includes("3.1")) {
      model = "pro-3.1";
    } else if (text.includes("flash") || text.includes("3.6")) {
      model = "flash-3.6";
    }

    return {
      model,
      extendedThinking: text.includes("extended")
    };
  }

  function resolvePickerState(value, hasSecondaryText) {
    return {
      ...inferPickerState(value),
      extendedThinking: Boolean(hasSecondaryText)
    };
  }

  function getModel(modelId) {
    return MODEL_OPTIONS.find((model) => model.id === modelId) || null;
  }

  function findExtendedOptionIndex(options) {
    if (!Array.isArray(options)) {
      return -1;
    }

    const afterSeparator = options.findIndex(
      (option) => option?.followsSeparator === true
    );
    if (afterSeparator >= 0) {
      return afterSeparator;
    }

    const nonModelIndexes = options
      .map((option, index) => ({
        index,
        text: normalizeText(option?.text).toLocaleLowerCase("en-US")
      }))
      .filter(({ text }) =>
        MODEL_OPTIONS.every(
          (model) =>
            !text.startsWith(model.menuPrefix.toLocaleLowerCase("en-US"))
        )
      )
      .map(({ index }) => index);

    return nonModelIndexes.length === 1 ? nonModelIndexes[0] : -1;
  }

  globalScope.GeminiDefaultModelCore = Object.freeze({
    DEFAULT_SETTINGS,
    MODEL_OPTIONS,
    findExtendedOptionIndex,
    getModel,
    inferPickerState,
    normalizeSettings,
    normalizeText,
    resolvePickerState
  });
})(globalThis);
