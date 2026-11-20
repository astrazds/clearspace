---
name: verify-clearspace
description: "Drive the Clearspace Chrome extension in Chromium. Use when loading the unpacked extension, opening the site popup, or proving the site switch, public-page cleanup, bundled update status, or an unavailable page."
---

# Verify Clearspace

Clearspace is a Manifest V3 Chrome extension. This skill loads the unpacked build in Chromium and drives the popup and a local page. It does not drive Safari. Safari stays the manual check in `docs/safari.md`.

Run every command from the repository root.

## Launch

Build the unpacked extension once. `dist/` is gitignored.

```bash
mise install
mise run install
mise run package
```

Start a fresh Chromium profile, the fixture server, and the extension. The driver downloads Playwright 1.62.1 and Chromium into `.cursor/skills/verify-clearspace/.tools/` when they are missing. The profile and Xvfb state live in `.cursor/skills/verify-clearspace/run/`.

```bash
node .cursor/skills/verify-clearspace/scripts/drive.mjs launch
```

Leave that process running. Ready is a stdout line that starts with `ready`. The process prints it only after all of these are true.

- The verify server owns `127.0.0.1:8877` and serves the fixture.
- Chromium has loaded `dist/unpacked/clearspace-<version>` in a new profile.
- `http://127.0.0.1:8877/article.html` shows one article, one sponsor note, and one ad slot, all visible.
- The popup was opened on that page, showed hostname `127.0.0.1` and status `Cleanup is off`, and was closed again.

`setup_ms` is the launch clock from process start through that line. `tools_ms` is the part spent on Playwright and Chromium. `popup_ms` is the part spent opening and closing that first popup. A listening port without the `ready` line is not ready.

Launch refuses a second session, a taken port 8877, a taken port 8878, or a taken display `:98`. Port 8878 carries doctor, run, and cleanup. Two browsers would share one profile and fight over the host switch.

## Doctor

Run this before a drive whenever the page looks wrong. It does not click, type, or reload.

```bash
node .cursor/skills/verify-clearspace/scripts/drive.mjs doctor
```

Exit 0 prints `doctor ok` with the server url, the page url, the driver pid, the port, the extension id, and the version. Anything else means do not drive. The check fails if the port is not this session, the manifest name is not Clearspace, the version differs from the session, the background worker count is not 1, or any fixture id matches a count other than 1.

## Drive

Read `features/README.md`, then one feature file. Run that file's commands from an empty profile. `cleanup` then `launch` is the empty profile.

The fixture page has three handles. Each recipe waits until the handle it acts on matches one element.

- `#clearspace-fixture-article` is the article. It stays visible.
- `#clearspace-fixture-note` is the sponsor note. Its class is `sponsor-note`. It stays visible. A hidden note means a rule matched more than the ad slot.
- `#clearspace-fixture-slot` is the ad slot. Its class is `ad-banner-container`, which is a bundled EasyList generic hide. Its id is not an EasyList id.

The popup handles are the switch named `Clean up this site`, `#site-status`, `#hostname`, the `Updates` summary, and the `Check now` button. `open-popup` loads `popup.html`, brings the article tab to the front, and reloads the popup so it reads the article. That is the same popup document the toolbar opens. This session has no toolbar click.

`127.0.0.1` starts with cleanup off. `article.test` is a public name mapped to `127.0.0.1`, and it starts with cleanup on. A status of `Cleanup is on` on `127.0.0.1` is not the public-page behavior. A hidden article is not a cleaned ad slot.

```bash
node .cursor/skills/verify-clearspace/scripts/drive.mjs run --evidence .cursor/skills/verify-clearspace/evidence/site-toggle --actions 'goto-private,shot-page:before,open-popup,assert-popup:127.0.0.1:Cleanup is off:unchecked,assert-page:visible:visible:visible:no-rule,shot-popup:popup-off,toggle,assert-page:hidden:visible:visible:rule,shot-page:after-on,open-popup,assert-popup:127.0.0.1:Cleanup is on:checked,shot-popup:popup-on,toggle,assert-page:visible:visible:visible:no-rule,shot-page:after-off,open-popup,assert-popup:127.0.0.1:Cleanup is off:unchecked,close-popup'
```

`pass evidence=... verify_ms=...` is a pass. `verify_ms` is only that command. A thrown check is a failure. Write the failure down and leave the journey as it is. `toggle` refuses to click when the status is `Setting saved. Reload to apply.` Do not press `Reload page` to make that journey pass.

## Evidence

The driver writes the directory you pass to `--evidence`. For the mapped features those directories are:

- `.cursor/skills/verify-clearspace/evidence/site-toggle`
- `.cursor/skills/verify-clearspace/evidence/public-cleanup`
- `.cursor/skills/verify-clearspace/evidence/updates`
- `.cursor/skills/verify-clearspace/evidence/unavailable-page`

`state.json` is the proof. Each step stores the action and the page or popup state after it. `console.txt` is the page, popup, and service worker console. A `shot-page` or `shot-popup` step also writes `<name>.png` and `<name>.aria.txt`.

A pass has to come from the popup and the fixture page. Do not call `chrome.runtime.sendMessage` from a test page. Do not rewrite `rules/` or `dist/`. The fixture is a local page. It does not stand in for the EasyList or HaGeZi download.

## Cleanup

Stop the session the driver started. This kills that driver pid, its Xvfb pid, and its Chromium pid when `/proc/<pid>/cmdline` still matches. It does not kill by process name. It deletes `.cursor/skills/verify-clearspace/run/` and leaves every evidence directory listed above.

```bash
node .cursor/skills/verify-clearspace/scripts/drive.mjs cleanup
```

`cleanup ok` means the processes are gone. Confirm the evidence directory from the drive still contains `state.json`. Run cleanup after a failed launch too, so a broken attempt does not keep the port or the display.

## Helpers

`drive.mjs` is the only helper. It is the way to start Chromium with the extension. Do not read `scripts/browser.mjs` to find the launch flags.

```bash
node .cursor/skills/verify-clearspace/scripts/drive.mjs launch
node .cursor/skills/verify-clearspace/scripts/drive.mjs doctor
node .cursor/skills/verify-clearspace/scripts/drive.mjs run --evidence .cursor/skills/verify-clearspace/evidence/site-toggle --actions 'goto-private,shot-page:before,open-popup,assert-popup:127.0.0.1:Cleanup is off:unchecked,assert-page:visible:visible:visible:no-rule,shot-popup:popup-off,toggle,assert-page:hidden:visible:visible:rule,shot-page:after-on,open-popup,assert-popup:127.0.0.1:Cleanup is on:checked,shot-popup:popup-on,toggle,assert-page:visible:visible:visible:no-rule,shot-page:after-off,open-popup,assert-popup:127.0.0.1:Cleanup is off:unchecked,close-popup'
node .cursor/skills/verify-clearspace/scripts/drive.mjs cleanup
```

## Keep the map current

When the popup or the fixture handles change, run `/maintain-verification-skill` and update the feature file that drifted.
