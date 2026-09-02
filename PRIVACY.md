# Privacy

Clearspace performs all page classification locally. It does not collect
telemetry, inspect cookies or history, call a network blocker, or send visited
hostnames or page URLs anywhere.

Its only runtime network traffic is a conditional download of the Hagezi Pro
wildcard list and EasyList from the two origins declared in `manifest.json`.
Preferences stay in `chrome.storage.local`; rule snapshots, compiled rules, and
source metadata stay in extension-owned IndexedDB.
