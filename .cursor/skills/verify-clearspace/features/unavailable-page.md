# Unavailable page

The popup disables the site switch when the active tab is not a website the content script can read. The status reads `Cleanup isn't available on this page.` The hostname stays hidden.

## Sub-features

- `unavailable-status` shows that exact status.
- `unavailable-switch` leaves `Clean up this site` unchecked and disabled, with the hostname hidden.

## How to get to it (user POV)

- Open the Clearspace popup while the active tab is the popup page itself, not the article.
- Read `Cleanup isn't available on this page.`
- The switch is disabled and no hostname is shown.

## Driving it with drive.mjs

Preconditions, from an empty profile:

```bash
mise install
mise run install
mise run package
node .cursor/skills/verify-clearspace/scripts/drive.mjs cleanup
node .cursor/skills/verify-clearspace/scripts/drive.mjs launch
node .cursor/skills/verify-clearspace/scripts/drive.mjs doctor
```

`doctor ok` is required. Then run this command unchanged.

```bash
node .cursor/skills/verify-clearspace/scripts/drive.mjs run --evidence .cursor/skills/verify-clearspace/evidence/unavailable-page --actions 'open-unavailable,assert-unavailable,shot-popup:unavailable,close-popup'
```

- **Open the popup on itself.** `open-unavailable` loads `popup.html` and reloads it without bringing the article tab forward. It waits until the status is not `Checking current page...`.
- **Prove the switch is unavailable.** `assert-unavailable` requires the status `Cleanup isn't available on this page.`, one unchecked disabled switch, and a hidden hostname. `shot-popup:unavailable` stores that popup. `close-popup` leaves the article tab.

## Gotchas

- Bringing the article tab forward makes this the site popup. `open-unavailable` does not do that. A status of `Cleanup is off` means the article was active.
- `Open a website to use Clearspace.` means there was no tab. That is not this result.
- The switch stays disabled. Do not click it.
