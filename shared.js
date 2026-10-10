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
      id: "flash-3.8",
      label: "3.8 Flash",
      description: "All-around help",
      menuPrefix: "3.8 Flash",
      fallbackId: "flash-3.7"
    }),
    Object.freeze({
      id: "flash-3.7",
      label: "3.7 Flash",
      description: "All-around help",
      menuPrefix: "3.7 Flash"
    }),
    Object.freeze({
      id: "pro-3.1",
      label: "3.1 Pro",
      description: "Advanced math and code",
      menuPrefix: "3.1 Pro"
    })
  ]);

  const THINKING_LEVELS = Object.freeze(["low", "medium", "high"]);
  const STORAGE_KEYS = Object.freeze(["model", "thinkingLevel", "extendedThinking"]);

  const DEFAULT_SETTINGS = Object.freeze({
    model: "flash-3.8",
    thinkingLevel: "high",
    extendedThinking: true
  });

  const MODEL_IDS = new Set(MODEL_OPTIONS.map((model) => model.id));

  function normalizeSettings(value) {
    const candidate = value && typeof value === "object" ? value : {};
    let model = candidate.model;
    if (model === "flash-3.6" || model === "flash-3.7") {
      model = "flash-3.8";
    }

    let thinkingLevel = candidate.thinkingLevel;
    if (!THINKING_LEVELS.includes(thinkingLevel)) {
      if (typeof candidate.extendedThinking === "boolean") {
        thinkingLevel = candidate.extendedThinking ? "high" : "low";
      } else {
        thinkingLevel = DEFAULT_SETTINGS.thinkingLevel;
      }
    }

    return {
      model: MODEL_IDS.has(model) ? model : DEFAULT_SETTINGS.model,
      thinkingLevel,
      extendedThinking: thinkingLevel !== "low"
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
    } else if (text.includes("3.7")) {
      model = "flash-3.7";
    } else if (text.includes("flash") || text.includes("3.8")) {
      model = "flash-3.8";
    }

    return { model };
  }

  function getModel(modelId) {
    return MODEL_OPTIONS.find((model) => model.id === modelId) || null;
  }

  function resolveModelWithFallback(modelId, isAvailable) {
    const target = getModel(modelId);
    if (!target) {
      return null;
    }
    if (typeof isAvailable !== "function" || isAvailable(target)) {
      return target;
    }
    if (target.fallbackId) {
      const fallback = getModel(target.fallbackId);
      if (fallback && isAvailable(fallback)) {
        return fallback;
      }
    }
    return target;
  }

  function findThinkingOptions(options) {
    if (!Array.isArray(options)) {
      return null;
    }

    const nonModelIndexes = options
      .map((option, index) => ({
        index,
        text: normalizeText(option?.text).toLocaleLowerCase("en-US")
      }))
      .filter(({ text, index }) =>
        !options[index]?.isModel && MODEL_OPTIONS.every(
          (model) =>
            !text.startsWith(model.menuPrefix.toLocaleLowerCase("en-US"))
        )
      )
      .map(({ index }) => index);

    const radioIndexes = nonModelIndexes.filter((index) => options[index]?.isRadio);
    if (radioIndexes.length) {
      return radioIndexes.length === 3
        ? { kind: "levels", indexes: radioIndexes }
        : null;
    }

    const groups = [];
    for (const index of nonModelIndexes) {
      if (!groups.length || options[index]?.followsSeparator) {
        groups.push([]);
      }
      groups[groups.length - 1].push(index);
    }
    const levelGroups = groups.filter((group) => group.length === 3);
    if (levelGroups.length === 1) {
      return { kind: "levels", indexes: levelGroups[0] };
    }

    return nonModelIndexes.length === 1
      ? { kind: "legacy", indexes: nonModelIndexes }
      : null;
  }

  function findThinkingOptionIndex(options, targetLevel) {
    if (!THINKING_LEVELS.includes(targetLevel)) {
      return -1;
    }
    const info = findThinkingOptions(options);
    return info
      ? info.indexes[info.kind === "legacy" ? 0 : THINKING_LEVELS.indexOf(targetLevel)]
      : -1;
  }

  function findExtendedOptionIndex(options) {
    return findThinkingOptionIndex(options, "high");
  }

  globalScope.GeminiDefaultModelCore = Object.freeze({
    DEFAULT_SETTINGS,
    MODEL_OPTIONS,
    STORAGE_KEYS,
    THINKING_LEVELS,
    findExtendedOptionIndex,
    findThinkingOptionIndex,
    findThinkingOptions,
    getModel,
    inferPickerState,
    normalizeSettings,
    normalizeText,
    resolveModelWithFallback
  });
})(globalThis);
