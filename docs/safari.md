# Experimental Safari support

The unchanged Clearspace 0.2.0 package has passed a limited manual smoke test
in macOS Safari 27.2. Chromium remains the browser covered by the automated
acceptance suite. This is not full Safari compatibility certification; iOS
Safari has not been tested.

## Load the package on macOS

1. Follow the [build instructions](../README.md#build-the-package).
2. In Safari, open **Settings → Advanced** and enable **Show features for web
   developers** if the Developer tab is not visible.
3. Open **Settings → Developer → Add Temporary Extension** and complete Safari's
   unsigned-extension authentication prompt.
4. Select `dist/unpacked/clearspace-<version>`. Enable Clearspace if necessary.
5. Open an HTTP(S) page and click Clearspace's toolbar button. Grant Safari
   website access for the site being tested, then reload the page.

Temporary folder loading requires Safari 18.4 or later. It does not require
an Xcode wrapper. Safari removes temporary extensions after 24 hours or when
Safari quits. After rebuilding, use **Settings → Extensions → Clearspace →
Reload**, then reload the test page. If the package version changes, load the
new version's directory.

Safari website access and Clearspace host preferences are separate controls.
Granting Safari access does not enable cleanup on a private host: private
hosts still require an explicit opt-in through Clearspace's site switch.

Apple documents this workflow in
[Running your Safari web extension](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension).
An Xcode project is needed for iOS testing or app-based distribution; neither
is part of the current release workflow.

## Verification scope

| Behavior | macOS Safari status |
| --- | --- |
| Load the existing package and open the popup | Verified manually |
| Read bundled rule status | Verified manually |
| Save a site toggle and retain it when reopening the popup | Verified manually |
| Exclude private hosts by default and enable one explicitly | Verified manually |
| Hide an element matched by a bundled cosmetic rule | Verified manually |
| Hide a dynamically inserted element matched by a bundled cosmetic rule | Verified manually |
| Keep ordinary content visible alongside those test elements | Verified manually |
| Download refreshed rules, handle failures, and deliver alarms | Not verified |
| Recover after background termination or browser restart | Not verified |
| Classify resource hosts, release resource markers, and handle frames | Not verified |
| Signed distribution and iOS Safari | Not verified |

Apple's converter reported a warning for the background `type` manifest key.
That warning did not prevent the startup and cosmetic behavior verified above.
Do not remove module support solely to silence the converter; reproduce an
actual runtime failure first.

## Repeat the cosmetic smoke test

Use the packaged extension and a local HTTP fixture, with other cleanup
extensions disabled for that fixture:

1. Include ordinary content and an element whose ID is `AC_ad`. The bundled
   EasyList snapshot contains the generic `###AC_ad` rule.
2. Grant Safari access to the local host. Confirm Clearspace starts off and
   both elements remain visible.
3. Enable cleanup through the popup. After its reload, confirm the test ad is
   hidden and ordinary content remains visible.
4. Insert an element whose ID is `AD_160` after page load. Confirm the bundled
   `###AD_160` rule hides it too.
5. Reopen the popup to check the saved setting. Restore the local host to off
   after testing.

Keep fixtures, screenshots, and receipts in ignored `artifacts/`. Do not edit
generated extension files or substitute direct storage writes for popup
actions. `mise run check` and `mise run test:browser` exercise Chromium only;
passing them does not establish Safari compatibility.
