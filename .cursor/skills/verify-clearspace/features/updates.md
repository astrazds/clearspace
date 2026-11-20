# Updates

Updates shows whether the extension is still on the bundled rule snapshots. On a fresh profile the disclosure reads `Using bundled rules.` and the button reads `Check now`. Check now contacts the two rule URLs from the manifest and then reads `Rules updated.` or `Rules are up to date.`

## Sub-features

- `updates-bundled` opens Updates and shows the bundled seed before any check.
- `updates-check` clicks `Check now` and waits for a successful check result.

## How to get to it (user POV)

- Open `http://127.0.0.1:8877/article.html`.
- Open the Clearspace popup.
- Click `Updates`.
- Read `Using bundled rules.` and the `Check now` button.
- Click `Check now` when you want a live check.

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

`doctor ok` is required. Run the bundled command first, on that fresh profile.

```bash
node .cursor/skills/verify-clearspace/scripts/drive.mjs run --evidence .cursor/skills/verify-clearspace/evidence/updates --actions 'goto-private,open-popup,open-updates,assert-updates:Using bundled rules.,shot-popup:bundled,close-popup'
```

- **Open the local page and the popup.** `goto-private` waits for the three visible fixture elements. `open-popup` waits until the status is not `Checking current page...`.
- **Open Updates.** `open-updates` clicks the one `Updates` summary and waits until `details` is open.
- **Prove the bundled seed.** `assert-updates:Using bundled rules.` waits for that exact `#refresh-result` text and for one enabled `Check now` button. `Last check succeeded.` means a check already ran. `Couldn't update.` is a failed check. `shot-popup:bundled` stores the open disclosure. `close-popup` leaves the page.

Run the live check only after the bundled command, in the same fresh profile. It replaces the bundled proof, so do not rerun the bundled command after it.

```bash
node .cursor/skills/verify-clearspace/scripts/drive.mjs run --evidence .cursor/skills/verify-clearspace/evidence/updates --actions 'goto-private,open-popup,open-updates,check-now,shot-popup:checked,close-popup'
```

- **Check now.** `check-now` clicks the one `Check now` button and waits for `Rules updated.` or `Rules are up to date.` The article and the sponsor note stay visible. `shot-popup:checked` stores the result.

## Gotchas

- `Using bundled rules.` is the fresh-profile result. Do not accept it as proof of `Check now`.
- `Checking for updates…` is the pending line. Wait for the final line.
- `Couldn't update.` and `Couldn't check for updates.` are failed checks. Report them. Do not pass the bundled line in their place.
- Run `check-now` from `127.0.0.1`, where cleanup is off. On a public host with cleanup on, a real rule change can also ask for a reload.
- The second command overwrites `state.json` in the same evidence directory. Keep `bundled.png` from the first command.
