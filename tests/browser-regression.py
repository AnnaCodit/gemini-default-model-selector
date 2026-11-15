"""Optional native-DOM regression check: python tests/browser-regression.py.

Requires Python Playwright and installed Chrome/Edge. Uses an isolated browser,
synthetic controls and a Chrome API stub; never opens an account or reads a profile.
"""

import os
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = r"""
config => {
  const labels = ['Low', 'Medium', 'High'];
  const names = { 'pro-3.1': '3.1 Pro', 'argon-4': '4 Argon' };
  const state = window.fixtureState = { model: 'pro-3.1', level: 'medium', clicks: [], errors: [] };
  const settings = { model: 'argon-4', thinkingLevel: 'high' };
  document.body.innerHTML = '<div class="input-area-container"><textarea>draft</textarea></div>';
  const composer = document.querySelector('div');
  let picker, menu, submenu, trigger, pendingCommit, listener;
  let pickerClicks = 0, submenuClicks = 0;
  const make = (tag, attrs = {}, text = '') => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    node.textContent = text;
    return node;
  };
  function updatePicker(replace = false) {
    if (!picker || replace) {
      picker?.remove();
      picker = make('button', { class: 'input-area-switch', 'aria-haspopup': 'menu',
        'aria-expanded': 'false', 'aria-controls': 'mode-menu' });
      composer.append(picker);
      picker.addEventListener('click', () => {
        state.clicks.push('picker');
        if (++pickerClicks <= (config.lostPickerClicks || 0)) {
          if (config.replacePicker) updatePicker(true);
          return;
        }
        if (picker.getAttribute('aria-expanded') !== 'true') openMenu();
      });
    }
    picker.textContent = names[state.model];
    if (state.level !== 'low') picker.append(make('span', { class: 'picker-secondary-text' },
      labels[['low', 'medium', 'high'].indexOf(state.level)]));
  }
  function closeMenu() {
    picker.setAttribute('aria-expanded', 'false');
    for (const node of [submenu, menu]) {
      if (!node?.isConnected) continue;
      node.style.opacity = '0';
      setTimeout(() => node.remove(), config.closeDelay);
    }
  }
  function renderLevels(container) {
    for (const [index, level] of ['low', 'medium', 'high'].entries()) {
      const item = make('button', { role: 'menuitemradio', 'aria-checked': String(state.level === level) });
      item.append(make('span', config.plainLabel ? {} : { class: 'label' }, labels[index]));
      item.append(make('span', { class: 'sublabel' }, ' Description ' + level));
      item.addEventListener('click', () => {
        state.clicks.push(level);
        pendingCommit = setTimeout(() => {
          pendingCommit = null;
          state.level = level;
          updatePicker();
          for (const [i, option] of [...container.querySelectorAll('[role="menuitemradio"]')].entries()) {
            option.setAttribute('aria-checked', String(i === index));
          }
          if (!config.keepOpen) closeMenu();
        }, config.commitDelay);
      });
      container.append(item);
    }
  }
  function openMenu() {
    picker.setAttribute('aria-expanded', 'true');
    menu = make('div', { id: 'mode-menu', role: 'menu', 'data-test-id': 'gem-mode-menu' });
    document.body.append(menu);
    for (const [id, name] of Object.entries(names)) {
      const item = make('button', { role: 'menuitem', 'data-mode-id': id }, name);
      item.addEventListener('click', () => {
        state.clicks.push(id);
        closeMenu();
        setTimeout(() => {
          state.model = id;
          state.level = 'low';
          updatePicker(config.replacePicker);
        }, config.modelDelay);
      });
      menu.append(item);
    }
    menu.append(make('hr', { role: 'separator' }));
    if (!config.nested) return renderLevels(menu);
    trigger = make('button', { role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      ...(config.unlinked ? {} : { 'aria-controls': 'thinking-menu' }) }, 'Thinking');
    menu.append(trigger);
    function showSubmenu() {
      if (trigger.getAttribute('aria-expanded') === 'true') return;
      trigger.setAttribute('aria-expanded', 'true');
      setTimeout(() => {
        submenu = make('div', { id: 'thinking-menu', role: 'menu' });
        document.body.append(submenu);
        renderLevels(submenu);
      }, config.submenuDelay);
    }
    trigger.addEventListener('click', () => {
      state.clicks.push('submenu');
      if (++submenuClicks > (config.lostSubmenuClicks || 0) && !config.hoverOnly) showSubmenu();
    });
    trigger.addEventListener('mouseenter', () => { if (config.hoverOnly) showSubmenu(); });
  }
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (pendingCommit) {
      clearTimeout(pendingCommit);
      state.errors.push('Escape interrupted a pending thinking commit');
    }
    closeMenu();
  });
  console.debug = (...args) => state.errors.push(args.join(' '));
  window.chrome = {
    storage: { sync: { get(_keys, callback) { setTimeout(() => callback(settings), 0); } },
      onChanged: { addListener() {} } },
    runtime: { onMessage: { addListener(callback) { listener = callback; } } }
  };
  window.initialResult = () => new Promise(resolve => listener({
    type: 'GEMINI_DEFAULT_MODEL_APPLY', settings, initialApplication: true, focusComposer: false, waitForUi: true
  }, {}, resolve));
  updatePicker();
}
"""


def browser_path():
    for directory in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"),
                      os.environ.get("LOCALAPPDATA")):
        if directory:
            for relative in ("Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe"):
                candidate = Path(directory) / relative
                if candidate.is_file():
                    return str(candidate)
    raise RuntimeError("Chrome or Edge is required for this optional check.")


def main():
    cases = [
        {},
        {"lostPickerClicks": 2, "replacePicker": True},
        {"keepOpen": True, "plainLabel": True},
        {"nested": True, "lostSubmenuClicks": 1, "keepOpen": True},
        {"nested": True, "hoverOnly": True, "unlinked": True},
        {"nested": True, "unlinked": True, "plainLabel": True, "replacePicker": True},
    ]
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=browser_path(), headless=True)
        try:
            for repetition in range(2):
                for index, case in enumerate(cases):
                    page = browser.new_page()
                    errors = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.set_content('<!doctype html><html><body></body></html>')
                    config = {"modelDelay": 40, "commitDelay": 80 + repetition * 37,
                              "closeDelay": 70, "submenuDelay": 50, **case}
                    page.evaluate(FIXTURE, config)
                    page.add_script_tag(content=(ROOT / "shared.js").read_text(encoding="utf-8"))
                    page.add_script_tag(content=(ROOT / "content.js").read_text(encoding="utf-8"))
                    page.wait_for_function("fixtureState.model === 'argon-4' && fixtureState.level === 'high'")
                    result = page.evaluate("initialResult()")
                    state = page.evaluate("fixtureState")
                    assert result.get("applied"), (index, result)
                    assert not errors and not state["errors"], (index, errors, state["errors"])
                    assert state["clicks"].count("picker") == 2 + config.get("lostPickerClicks", 0), (index, state)
                    assert page.locator('textarea').input_value() == 'draft'
                    assert not page.locator('[role="menu"]').count(), index
                    print(f"PASS native DOM case {index + 1}, repetition {repetition + 1}")
                    page.close()
        finally:
            browser.close()
    print("12 native DOM scenarios passed; live Gemini and extension transport are not simulated here.")


if __name__ == "__main__":
    main()
