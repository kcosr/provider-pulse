# Provider Pulse repository guide

Read `~/agent-context/repos/provider-pulse/AGENTS.md` and its `design.md`
before changing this application. The design is the product and architecture
contract.

Provider Pulse is a standalone loopback application. Keep provider credentials
in their native CLI or Pi homes; never copy, log, expose, or persist tokens in
application status. Use argument arrays with `shell: false` for every child
process. Browser action requests may select only configured opaque IDs and must
never supply executable paths, homes, environment variables, models, reasoning,
prompts, or command arguments.

Fireworks is deferred. Do not add it to the initial runtime merely because the
UI context contains a future-state example.

Use Node.js 22.12 or newer and avoid Node 24-only APIs. Install dependencies
with `npm ci --ignore-scripts`.
After code changes, run:

```sh
npm run typecheck
npm test
npm run build
```

Live provider probes and heartbeat turns access real account state and can
consume capacity. Unit and integration tests must use fakes. Do not send real
heartbeat model requests during ordinary verification unless the user
explicitly asks for a live heartbeat test.

Do not commit configuration containing real account emails, credential paths,
or other host-local details. Keep the committed config example synthetic.
