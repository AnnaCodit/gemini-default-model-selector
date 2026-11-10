"""Render transparent PNG icons from icon.svg.

Requires Python, Pillow, Playwright, and an installed Chrome or Edge browser.
Run from any directory: python assets/icons/render-icons.py
"""

import os
from io import BytesIO
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright


ICON_DIR = Path(__file__).resolve().parent
STORE_SOURCE_DIR = ICON_DIR.parent / "store" / "source"
SIZES = (16, 32, 48, 128)


def find_browser():
    for directory in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"),
                      os.environ.get("LOCALAPPDATA")):
        if not directory:
            continue
        for relative in ("Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe"):
            candidate = Path(directory) / relative
            if candidate.is_file():
                return str(candidate)
    raise RuntimeError("Install Chrome or Edge before rendering the icons.")


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=find_browser(), headless=True)
        try:
            page = browser.new_page(viewport={"width": 512, "height": 512}, device_scale_factor=1)
            page.set_content('<style>html,body{margin:0;width:512px;height:512px}svg{display:block;'
                             'width:512px;height:512px}</style>'
                             + (ICON_DIR / "icon.svg").read_text(encoding="utf8"))
            rendered = page.locator("svg").screenshot(omit_background=True)
        finally:
            browser.close()

    with Image.open(BytesIO(rendered)) as source:
        for size in SIZES:
            icon = source.resize((size, size), Image.Resampling.LANCZOS)
            output = ICON_DIR / f"icon-{size}.png"
            icon.save(output)
            if size in (32, 48):
                icon.save(STORE_SOURCE_DIR / output.name)
            print(f"Rendered icon-{size}.png ({size} x {size}, {icon.mode})")


if __name__ == "__main__":
    main()
