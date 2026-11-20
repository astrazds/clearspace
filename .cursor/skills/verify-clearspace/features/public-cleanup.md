# Public cleanup

A public host starts with cleanup on. Opening `article.test` hides the ad slot with the bundled EasyList rule and leaves the article and the sponsor note on the page. The popup shows that host as on.

## Sub-features

- `public-hide` hides `#clearspace-fixture-slot` and keeps the article and the sponsor note visible.
- `public-popup` shows hostname `article.test`, status `Cleanup is on`, and a checked switch.

## How to get to it (user POV)

- Open `http://article.test:8877/article.html`.
- The sponsor slot is gone. The article and the sponsor note stay.
- Open the Clearspace popup. The hostname reads `article.test` and the status reads `Cleanup is on`.

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
node .cursor/skills/verify-clearspace/scripts/drive.mjs run --evidence .cursor/skills/verify-clearspace/evidence/public-cleanup --actions 'goto-public,shot-page:page,open-popup,assert-popup:article.test:Cleanup is on:checked,assert-page:hidden:visible:visible:rule,shot-popup:popup,close-popup'
```

- **Open the public page.** `goto-public` loads `http://article.test:8877/article.html`. It waits until the cosmetic stylesheet is attached, the ad slot is hidden, and the article and sponsor note are visible.
- **Record the page.** `shot-page:page` writes `page.png` with the article still on screen and the ad slot gone.
- **Open the popup.** `open-popup` waits for a ready status and one switch.
- **Prove this is the public host, not the local host.** `assert-popup:article.test:Cleanup is on:checked` requires that hostname and a checked switch. A popup that says `127.0.0.1` is the private-host journey.
- **Prove the hide is the ad slot.** `assert-page:hidden:visible:visible:rule` requires the bundled `.ad-banner-container` rule, a hidden ad slot, and a visible article and sponsor note. `shot-popup:popup` stores the popup. `close-popup` leaves the page.

## Gotchas

- `article.test` is mapped to `127.0.0.1` by the driver. The popup hostname is still `article.test`.
- A profile that already turned `article.test` off will not show `Cleanup is on`. Run `cleanup` and `launch` first.
- Hiding the article or the sponsor note fails the recipe even if the ad slot is hidden.
- This recipe does not click the switch. A click belongs to the site switch recipe.
