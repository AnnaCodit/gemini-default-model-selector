const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const manifestSource = read("manifest.json");
const runtimeSource = ["popup.html", "popup.js", "background.js", "content.js"].map(read).join("\n");
const listing = read("STORE_LISTING.md");
const referencedKeys = new Set([
  ...Array.from(manifestSource.matchAll(/__MSG_([a-z_]+)__/g), ([, key]) => key),
  ...Array.from(runtimeSource.matchAll(/\bpopup_[a-z_]+\b/g), ([key]) => key)
]);
const readCatalog = (locale) => JSON.parse(read(`_locales/${locale}/messages.json`));
const english = readCatalog("en");

for (const [locale, language] of [
  ["en", "en"], ["es", "es"], ["es_419", "es"], ["pt_BR", "pt-BR"], ["zh_CN", "zh-CN"], ["ru", "ru"]
]) {
  test(`${locale} covers the manifest and popup with valid store metadata`, () => {
    const catalog = readCatalog(locale);
    assert.deepEqual(new Set(Object.keys(catalog)), referencedKeys);
    assert.equal(catalog.popup_language.message, language);

    for (const [key, entry] of Object.entries(catalog)) {
      assert.ok(entry.message.trim(), `${locale}: empty ${key}`);
      const placeholders = Array.from(entry.message.matchAll(/\$([a-z_]+)\$/gi),
        ([, name]) => name.toLowerCase());
      assert.deepEqual(placeholders.sort(), Object.keys(english[key].placeholders ?? {}).sort(), key);
      assert.deepEqual(entry.placeholders, english[key].placeholders, key);
    }

    const title = catalog.extension_name.message;
    const summary = catalog.extension_description.message;
    assert.ok(title.length <= 75);
    assert.ok(summary.length <= 132);
    assert.ok(listing.includes(`| ${title} | ${summary} |`));
  });
}

test("English is the default and both Spanish locales use the same translation", () => {
  assert.equal(JSON.parse(manifestSource).default_locale, "en");
  assert.deepEqual(readCatalog("es_419"), readCatalog("es"));
});
