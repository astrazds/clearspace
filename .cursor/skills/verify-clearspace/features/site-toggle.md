# Site switch

The site switch turns cleanup on or off for the current host. On `127.0.0.1` it starts off. Turning it on hides the ad slot after the page reloads. Turning it off brings the ad slot back. The article and the sponsor note stay visible both ways.

## Sub-features

- `site-off` shows cleanup off, with the ad slot, the article, and the sponsor note all visible.
- `site-on` hides the ad slot with the bundled `.ad-banner-container` rule and leaves the other two visible.
- `site-off-again` brings the ad slot back and removes that stylesheet.

## How to get to it (user POV)

- Open `http://127.0.0.1:8877/article.html`.
- Open the Clearspace popup. The hostname reads `127.0.0.1` and the status reads `Cleanup is off`.
- Click the switch `Clean up this site`. The popup reloads the page and closes.
- Open the popup again. The status reads `Cleanup is on` and the sponsor slot is gone.
- Click the switch again. The sponsor slot comes back and the status reads `Cleanup is off`.

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
node .cursor/skills/verify-clearspace/scripts/drive.mjs run --evidence .cursor/skills/verify-clearspace/evidence/site-toggle --actions 'goto-private,shot-page:before,open-popup,assert-popup:127.0.0.1:Cleanup is off:unchecked,assert-page:visible:visible:visible:no-rule,shot-popup:popup-off,toggle,assert-page:hidden:visible:visible:rule,shot-page:after-on,open-popup,assert-popup:127.0.0.1:Cleanup is on:checked,shot-popup:popup-on,toggle,assert-page:visible:visible:visible:no-rule,shot-page:after-off,open-popup,assert-popup:127.0.0.1:Cleanup is off:unchecked,close-popup'
```

- **Open the local page.** `goto-private` loads the fixture on `127.0.0.1` and waits until the article, the sponsor note, and the ad slot are each one visible element.
- **Record the page.** `shot-page:before` writes `before.png` while the ad slot is still on screen.
- **Open the popup.** `open-popup` waits until `#site-status` is not `Checking current page...` and the switch matches one element.
- **Prove cleanup is off.** `assert-popup:127.0.0.1:Cleanup is off:unchecked` and `assert-page:visible:visible:visible:no-rule`. The hostname, the off status, the unchecked switch, the three visible elements, and the absent stylesheet have to agree. `shot-popup:popup-off` stores that popup.
- **Turn cleanup on.** `toggle` clicks the switch, waits until the popup closes, waits until the page reloads, then waits until the ad slot is hidden and the stylesheet is attached.
- **Prove the ad slot is the thing that changed.** `assert-page:hidden:visible:visible:rule` requires the ad slot hidden, the article visible, the sponsor note visible, and `.ad-banner-container{display:none!important}` inside the one cosmetic stylesheet. `shot-page:after-on` stores that page.
- **Read the popup again.** `open-popup`, `assert-popup:127.0.0.1:Cleanup is on:checked`, and `shot-popup:popup-on`. The saved switch matches the page.
- **Turn cleanup off.** `toggle` waits until the stylesheet is gone and the ad slot is visible again.
- **Prove the ad slot came back.** `assert-page:visible:visible:visible:no-rule`, `shot-page:after-off`, then `open-popup` and `assert-popup:127.0.0.1:Cleanup is off:unchecked`. `close-popup` leaves the article tab.

## Gotchas

- A fresh profile is required. A profile that already enabled `127.0.0.1` does not start at `Cleanup is off`.
- `toggle` refuses a status of `Setting saved. Reload to apply.` That means the page did not reload. Do not click `Reload page` to force the recipe green.
- `Cleanup is on` with a visible ad slot is not a pass. `Cleanup is off` with a hidden ad slot is not a pass.
- A hidden article or a hidden sponsor note is not a pass, even when the ad slot is hidden.
- The popup has to be opened with `open-popup`. A popup whose active tab is itself reports that cleanup is not available.
