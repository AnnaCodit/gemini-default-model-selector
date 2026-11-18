"""Render the store screenshots from the current popup and regenerate the promo tile.

Requires Python, Pillow, Playwright, and an installed Chrome or Edge browser.
Run from any directory: python assets/store/source/render-store-images.py
"""

import json
import os
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright


SOURCE_DIR = Path(__file__).resolve().parent
STORE_DIR = SOURCE_DIR.parent
PROJECT_DIR = SOURCE_DIR.parents[2]
EXAMPLE_CATALOG = [
    {"id": "auto", "label": "Auto", "available": True},
    {"id": "hydrogen-4", "label": "4 Hydrogen", "available": True},
    {"id": "mode:neon", "label": "4 Neon", "available": True},
    {"id": "carbon-4", "label": "4 Carbon", "available": False},
]


def find_browser():
    for directory in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"),
                      os.environ.get("LOCALAPPDATA")):
        if not directory:
            continue
        for relative in ("Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe"):
            candidate = Path(directory) / relative
            if candidate.is_file():
                return str(candidate)
    raise RuntimeError("Install Chrome or Edge before rendering the store images.")


def make_opaque(path):
    with Image.open(path) as image:
        image.convert("RGB").save(path)


def capture_popup(browser, theme, model, thinking_level):
    context = browser.new_context(viewport={"width": 330, "height": 800},
                                  color_scheme=theme, device_scale_factor=2)
    # The isolated capture uses example preferences, never the user's browser profile.
    # Only read APIs are mocked; saving or applying preferences is not simulated.
    page = context.new_page()
    example = {"model": model, "thinkingLevel": thinking_level, "catalog": EXAMPLE_CATALOG}
    page.add_init_script("""
        const { model, thinkingLevel, catalog } = EXAMPLE;
        globalThis.chrome = {
          runtime: {},
          storage: {
            local: { get(_key, callback) { callback({ modelCatalog: catalog }); } },
            sync: { get(_keys, callback) { callback({ model, thinkingLevel }); } },
            onChanged: { addListener() {} }
          },
          tabs: { query(_options, callback) { callback([]); } },
          permissions: { async contains() { return true; } },
          commands: { async getAll() {
            return [{ name: "open-gemini", shortcut: "Alt+G" }];
          } }
        };
    """.replace("EXAMPLE", json.dumps(example)))
    page.goto((PROJECT_DIR / "popup.html").as_uri())
    page.locator("#status").filter(has_text="Changes save automatically").wait_for()
    page.locator("#open-gemini-shortcut").filter(has_text="(Alt+G)").wait_for()
    selected_model = page.locator(f'input[name="model"][value="{model}"]')
    selected_level = page.locator(f'input[name="thinkingLevel"][value="{thinking_level}"]')
    if not selected_model.is_checked() or not selected_level.is_checked():
        raise RuntimeError("The popup did not display the requested example preferences.")
    if selected_level.is_disabled() != (model == "auto"):
        raise RuntimeError("The popup displayed the wrong thinking controls for the example model.")
    locked_model = page.locator('input[name="model"][value="carbon-4"]')
    if not locked_model.is_disabled():
        raise RuntimeError("The popup did not show Carbon as unavailable.")
    page.evaluate("document.fonts.ready")
    output = SOURCE_DIR / f"popup-settings-{theme}.png"
    page.locator("body").screenshot(path=str(output), animations="disabled")
    make_opaque(output)
    context.close()
    with Image.open(output) as image:
        return image.size


def render_artwork(browser, source_name, output_name, size):
    width, height = size
    page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
    page.goto((SOURCE_DIR / source_name).as_uri())
    page.evaluate("document.fonts.ready")
    output = STORE_DIR / output_name
    page.locator("svg").screenshot(path=str(output), animations="disabled")
    make_opaque(output)
    page.close()
    with Image.open(output) as image:
        if image.size != size or image.mode != "RGB":
            raise RuntimeError(f"{output_name} must be an opaque {width} x {height} image.")


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=find_browser(), headless=True)
        try:
            for theme, model, level in (("light", "mode:neon", "high"), ("dark", "auto", "medium")):
                size = capture_popup(browser, theme, model, level)
                print(f"Popup {theme}: {size[0]} x {size[1]}")
            for source_name, output_name, size in (
                ("store-shot-settings.svg", "screenshot-1-settings-1280x800.png", (1280, 800)),
                ("store-shot-applied.svg", "screenshot-2-applied-1280x800.png", (1280, 800)),
                ("store-promo-small.svg", "promo-small-440x280.png", (440, 280)),
            ):
                render_artwork(browser, source_name, output_name, size)
                print(f"Rendered {output_name}")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
