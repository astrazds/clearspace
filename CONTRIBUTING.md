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
   npm ci
   npx playwright install chromium
   npm run check
   ```

## Pull requests

Explain the problem, the chosen approach, and how you verified it. Add or update
tests for behavioral changes. By contributing, you agree that your contribution
is licensed under the repository's GPL-3.0-only license.
