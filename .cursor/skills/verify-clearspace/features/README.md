# Clearspace verification map

This directory is the maintained source for verifying the user-facing behavior of Clearspace. Read the index, then use one feature file as the recipe.

## Baseline preconditions

A fresh profile is `cleanup`, then `launch`, from the repository root.

```bash
mise install
mise run install
mise run package
node .cursor/skills/verify-clearspace/scripts/drive.mjs cleanup
node .cursor/skills/verify-clearspace/scripts/drive.mjs launch
node .cursor/skills/verify-clearspace/scripts/drive.mjs doctor
```

Require a `ready` line, then `doctor ok`, before any recipe. Do not drive a browser this session did not start.

## Driving conventions

- `#clearspace-fixture-article`, `#clearspace-fixture-note`, and `#clearspace-fixture-slot` each match one element before a page assert.
- The switch `Clean up this site` matches one element before a click.
- `open-popup` continues only after `#site-status` is no longer `Checking current page...`.
- `assert-page` tokens are ad slot, article, sponsor note, then `rule` or `no-rule`.
- `rule` means one `style[data-clearspace="cosmetic"]` contains `.ad-banner-container{display:none!important}`.
- `no-rule` means that style element is absent.
- Keep `state.json`. Cleanup does not remove it.

## Proof and skip reporting

- A passing recipe writes `state.json` whose steps show the action and the state after it.
- The article and the sponsor note stay visible. If either is hidden, the recipe did not show cleanup of the ad slot.
- Report a recipe that cannot run with the command and the unmet precondition. Do not mark it passed through a different recipe.

## Features

- [Site switch](./site-toggle.md) turns cleanup on and off for `127.0.0.1`.
- [Public cleanup](./public-cleanup.md) hides the ad slot on `article.test` while the article stays.
- [Updates](./updates.md) shows the bundled rule status, then checks for rule updates.
- [Unavailable page](./unavailable-page.md) disables the switch when the active tab is not a website.
