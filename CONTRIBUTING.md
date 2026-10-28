# Contributing to Clearspace

Thanks for taking an interest in Clearspace. Small, focused changes are easiest
to review.

## Before opening a pull request

1. Open an issue for behavior changes or substantial new work so the scope can
   be agreed first.
2. Keep the extension cosmetic-only. Changes must not add telemetry, request
   interception, browsing-history access, cookies, or unrelated host
   permissions.
3. Do not commit generated output, browser profiles, test artifacts, or updated
   upstream rule snapshots without documenting their provenance and license.
4. Run the complete check:

   ```sh
   mise install
   mise run install
   mise run install:browser
   mise run check
   ```

Read [ARCHITECTURE.md](ARCHITECTURE.md) to locate the owner and behavioral test
for your change. Runtime JavaScript contracts are checked with TypeScript.
Browser verification runs the packaged extension in an isolated profile.

## Pull requests

Explain the problem, the chosen approach, and how you verified it. Add or update
tests for behavioral changes. By contributing, you agree that your contribution
is licensed under the repository's GPL-3.0-only license.

## Version labels

Every PR needs exactly one label before merging:

| Label | Use | Example |
| --- | --- | --- |
| `release:minor` | Features, including a mixture of features and fixes | `0.1.1` → `0.2.0` |
| `release:patch` | Fixes without a new feature | `0.1.0` → `0.1.1` |
| `release:none` | Documentation, tests, or maintenance with no product change | Version unchanged |

Use `minor` for a feature plus fixes; do not apply two release labels. The
Release label check rejects missing/conflicting labels and bumps on PRs whose
files are exclusively documentation or tests. Reviewers decide the meaning of
other changes, including dependency and build changes. Major releases require
an explicit policy change; they are never inferred automatically.

After successful CI on `main`, **Version merged PRs** processes every unrecorded
merge in main's first-parent order. It creates one bot commit per PR, updating
`package.json`, `package-lock.json`, and `manifest.json` together for features
and fixes. No-release PRs get only a processing record. Do not bump versions or
edit `release-state.json` in ordinary PRs. The activation baseline excludes old
PRs; the PR introducing this system is its first minor release (`0.2.0`).

The workflow runs the full gate before each push because bot-token pushes do
not start ordinary push CI. Packaging also rejects inconsistent versions.
Chrome-compatible versions are numeric `major.minor.patch` values with each
component at most 65535; reaching a limit fails rather than wrapping.

If the workflow fails, inspect its first error. Correct an unprocessed PR's
release label if necessary, fix failing code through a PR, or restore the bot's
existing permission to push under the repository's approved policy. Then run
**Actions → Version merged PRs → Run workflow**, choosing `main`. It resumes
from the durable record without bumping completed PRs again. Changing labels
after a PR is recorded does not rewrite its version. Never delete processing
records or force-push to retry. Future branch protection that disallows bot
commits needs an explicit workflow redesign; the job will not bypass it.

Build with `mise run package` after pulling the version commit. The unpacked
directory includes the new version, so select that directory when loading the
new build in Chrome. Versioning does not publish to an extension store, create
GitHub releases/tags, or reload installed extensions.
