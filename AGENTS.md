# Working on Clearspace

Read `ARCHITECTURE.md` for the owner and behavioral test of each subsystem.

- Use `mise run install` for locked dependencies and `mise run check` for the
  complete gate. Use `mise run test:browser` for packaged Chromium verification.
- Keep Chrome event wiring in `background.js` and worker state in
  `src/worker-service.js`. Keep pure parsers independent of Chrome.
- Define message names and checked payloads in `src/protocol.js`. Content source
  lives in `src/content/entry.js`; packaging generates classic `content.js`.
- Preserve protocol v1, IndexedDB v1, preference shapes, manifest permissions,
  offline seeds, exact-host controls, and private-host default exclusion.
- Preserve cosmetic-only behavior. Do not add network blocking, visited-host
  export, arbitrary ancestor collapse, or live page reconfiguration.
- Test observable behavior. Browser cases must exercise the packaged extension.
  Reproduce bugs there before fixing them. Do not replace a failed user action
  with a second direct API write in a test.
- Do not edit generated output, rule snapshots, or lockfiles manually. Use the
  package manager for dependency and lockfile updates.
- Keep local plans, screenshots, receipts, and decision logs in ignored
  `artifacts/`. Public documentation must describe the project without personal
  machine details or agent-session history.
