"""Render store artwork from the extension's current popup.

Requires Python, Pillow, Playwright, and an installed Chrome or Edge browser.
Run from any directory: python assets/store/source/render-store-images.py
"""

import os
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright


SOURCE_DIR = Path(__file__).resolve().parent
STORE_DIR = SOURCE_DIR.parent
PROJECT_DIR = SOURCE_DIR.parents[2]


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


def capture_popup(browser, theme, model):
    context = browser.new_context(viewport={"width": 330, "height": 800},
                                  color_scheme=theme, device_scale_factor=2)
    # The isolated capture uses example preferences, never the user's browser profile.
    # Only read APIs are mocked; saving or applying preferences is not simulated.
    page = context.new_page()
    page.add_init_script("""
        globalThis.chrome = {
          storage: { sync: { get(_keys, callback) {
            callback({ model: MODEL_ID, thinkingLevel: "high" });
          } } },
          commands: { async getAll() {
            return [{ name: "open-gemini", shortcut: "Alt+G" }];
          } }
        };
    """.replace("MODEL_ID", repr(model)))
    page.goto((PROJECT_DIR / "popup.html").as_uri())
    page.locator("#status").filter(has_text="Changes save automatically").wait_for()
    page.locator("#open-gemini-shortcut").filter(has_text="(Alt+G)").wait_for()
    if not page.locator(f'input[name="model"][value="{model}"]').is_checked():
        raise RuntimeError("The popup did not display the requested example model.")
    page.evaluate("document.fonts.ready")
    output = SOURCE_DIR / f"popup-settings-{theme}.png"
    page.locator("body").screenshot(path=str(output), animations="disabled")
    make_opaque(output)
    context.close()
    with Image.open(output) as image:
        return image.size


def render_artwork(browser, source_name, output_name):
    page = browser.new_page(viewport={"width": 1280, "height": 800}, device_scale_factor=1)
    page.goto((SOURCE_DIR / source_name).as_uri())
    page.evaluate("document.fonts.ready")
    page.locator("svg").screenshot(path=str(STORE_DIR / output_name), animations="disabled")
    make_opaque(STORE_DIR / output_name)
    page.close()


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=find_browser(), headless=True)
        try:
            for theme, model in (("light", "flash-3.8"), ("dark", "argon-4")):
                size = capture_popup(browser, theme, model)
                print(f"Popup {theme}: {size[0]} x {size[1]}")
            for source_name, output_name in (
                ("store-shot-settings.svg", "screenshot-1-settings-1280x800.png"),
                ("store-shot-applied.svg", "screenshot-2-applied-1280x800.png"),
            ):
                render_artwork(browser, source_name, output_name)
                print(f"Rendered {output_name}")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
