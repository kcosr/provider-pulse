# Provider Pulse

Provider Pulse is a small, standalone local web application for checking LLM
subscription usage and keeping selected CLI credential surfaces active with
minimal model heartbeats. It is independent of Harness: it never changes the
credentials, sessions, targets, or rollout storage used by another app.

Provider Pulse supports Codex, Claude, Grok, and structured Fireworks account
and quota polling. See [the Fireworks integration notes](docs/fireworks-follow-up.md).

## What it does

- Shows every configured account under an operator-chosen label.
- Provides a browser-remembered toggle that redacts account labels and identity
  text from the dashboard without changing the status API.
- Reports all provider usage windows it can observe, including reset times.
- Reports Codex banked reset-credit counts and bounded credit details when the
  app-server exposes them; it never redeems a credit.
- Shows seven-day quota windows as seven elapsed-time cells alongside capacity.
- Compares an optional expected email with the identity observed by the CLI.
- Records the current usage-poll and heartbeat health in memory.
- Runs per-account or bulk usage checks from the web page.
- Saves one server-side comparison baseline and shows usage consumed since it.
- Runs manual or reset-aware native-CLI and Pi heartbeats.
- Exposes one normalized JSON status object at `GET /api/status`.
- Writes bounded diagnostic JSONL logs plus minimal scheduler and usage-baseline
  state files.

Status starts as unknown after every process restart. Provider Pulse is not a
usage-history database and does not reconstruct dashboard status from its log.
The current comparison baseline is intentionally reloaded from its small state
file.

## Requirements

- Node.js 22.12 or newer
- tmux
- The provider CLIs selected by the configuration (`codex`, `claude`, `grok`,
  and/or `pi`)
- A Fireworks API key when a `fireworks-api` usage surface is configured
- Linux with `systemd --user` for the optional service setup

Codex polling uses its structured app-server protocol. Claude and Grok usage
polling requires tmux because their usage data is currently exposed through
interactive `/usage` screens rather than a suitable headless JSON command.
Each Codex poll asks the app-server to refresh its OAuth access token before
reading quota data. This keeps an authenticated monitoring home usable without
sending a model request.
Fireworks polling calls the official structured account, quota, and billing
summary APIs. It shows account identity, health, and exact calendar-month
spend. A finite monthly budget is also shown as capacity remaining.
Fireworks' web UI shows prepaid credits, but its documented API-key management
APIs do not expose that balance, so the card marks it `Web only` rather than
estimating it.

## Install and verify

```sh
git clone https://github.com/kcosr/provider-pulse.git \
  "$HOME/.local/share/provider-pulse/app"
cd "$HOME/.local/share/provider-pulse/app"
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

Tests use fake provider processes and do not send model requests. A real
heartbeat always consumes provider capacity and can start or advance a quota
window; do not use a heartbeat as an installation test.

## Local directories

The recommended layout follows the XDG base-directory convention:

| Purpose | Default location |
| --- | --- |
| Operator configuration | `~/.config/provider-pulse/config.json` |
| Scheduler cursor | `~/.local/state/provider-pulse/scheduler-state.json` |
| Usage comparison baseline | `~/.local/state/provider-pulse/usage-baseline.json` |
| Rotating diagnostic log | `~/.local/state/provider-pulse/events.jsonl` |
| Temporary probe working directory | `~/.local/state/provider-pulse/probes/` |
| Isolated native and Pi credential homes | `~/.local/share/provider-pulse/homes/` |
| Standalone Fireworks API key | `~/.config/provider-pulse/fireworks-api-key` |

Create them with owner-only permissions:

```sh
install -d -m 0700 "$HOME/.config/provider-pulse"
install -d -m 0700 "$HOME/.local/state/provider-pulse/probes"
install -d -m 0700 "$HOME/.local/share/provider-pulse/homes"
install -m 0600 config.example.json "$HOME/.config/provider-pulse/config.json"
```

Edit `config.json` before starting the service. The schema is strict: unknown
fields, duplicate IDs, bad cross-references, invalid executables, and invalid
home paths fail startup instead of being silently ignored. The committed
`config.example.json` is synthetic and safe to copy as a starting point.

Each account label is configured explicitly. Labels such as `primary`,
`backup`, or `personal 2` are not inferred from an email address. The optional
`expectedIdentity.email` detects when the credential in a home has been
replaced; a mismatch blocks heartbeats but remains visible in usage status.

## Provision isolated credentials

Provider Pulse delegates login to the CLI that owns each credential store. Give
each surface its own directory and authenticate it directly:

```sh
install -d -m 0700 "$HOME/.local/share/provider-pulse/homes/codex-primary"
CODEX_HOME="$HOME/.local/share/provider-pulse/homes/codex-primary" codex login

install -d -m 0700 "$HOME/.local/share/provider-pulse/homes/claude-primary"
CLAUDE_CONFIG_DIR="$HOME/.local/share/provider-pulse/homes/claude-primary" claude auth login

install -d -m 0700 "$HOME/.local/share/provider-pulse/homes/grok-primary"
GROK_HOME="$HOME/.local/share/provider-pulse/homes/grok-primary" grok login

install -d -m 0700 "$HOME/.local/share/provider-pulse/homes/pi-grok-primary"
PI_CODING_AGENT_DIR="$HOME/.local/share/provider-pulse/homes/pi-grok-primary" pi
```

For Pi, use the interactive `/login` flow and select the intended provider,
then exit. Configure that same directory as the Pi credential surface.

For Fireworks, store one API key in a standalone owner-only file. This is not a
Pi credential or heartbeat surface:

```sh
install -m 0600 /path/to/fireworks-api-key \
  "$HOME/.config/provider-pulse/fireworks-api-key"
```

Configure a `fireworks-api` credential surface with that `credentialFile`, and
pin its logical account with `expectedIdentity.accountId`. Provider Pulse reads
the key for management API requests but never returns its contents or path.

Do not copy OAuth files from an actively used CLI home into a monitoring home.
Providers may rotate refresh tokens, so copied homes can invalidate one
another. Log into each isolated home separately. A native credential and a Pi
credential remain separate even when both represent the same provider account;
a heartbeat through one does not refresh the other.

When `expectedIdentity` is configured, Provider Pulse can verify only the
credential surface used by that account's usage source. A heartbeat configured
on a different native or Pi home is blocked with
`heartbeat_identity_unverifiable`; omit `expectedIdentity` only when you
intentionally trust that separately provisioned surface without an identity
assertion.

## Configuration model

The top-level configuration defines:

- `server`: loopback host and port;
- `paths`: state and probe directories;
- `polling`: startup behavior, optional low-frequency polling, concurrency,
  and freshness;
- `credentialSurfaces`: executable plus isolated home for each native CLI or
  Pi credential;
- `accounts`: labels, expected identity, and usage adapter;
- `heartbeatJobs`: the exact account, credential surface, executor, provider,
  model, reasoning, prompt, timeout, and trigger.

Browser requests contain only configured account or heartbeat IDs. Executable
paths, homes, environment variables, models, prompts, and arguments are never
accepted from the browser.

At startup, every configured Pi heartbeat provider/model pair is checked
against that Pi home's local model catalog in offline mode. A missing pair
fails startup; the catalog check does not send an inference request.

Usage polling and heartbeat execution are separate operations. General polling
is manual-first. A reset-aware heartbeat selects a normalized usage window and
runs once after the observed reset plus its configured offset. The internal
minute timer only compares timestamps; it makes no provider request.

Reset-aware `windowId` values come from the normalized status API:

- Claude: `session`, `weekly`, and `<model>-weekly` such as
  `fable-5-weekly`;
- Grok: `weekly`;
- Codex: `<limit-id>:primary` or `<limit-id>:secondary`, using the exact IDs
returned for that account by `GET /api/status`.

An account may hide provider windows by exact normalized ID without changing
the adapter:

```json
"usageSource": {
  "adapter": "codex-app-server",
  "credentialSurfaceId": "codex-primary-native",
  "hiddenWindowIds": ["codex_bengalfox:primary"]
}
```

Hidden windows are removed before status storage, comparison baselines, and
reset scheduling, so they do not appear in the dashboard or `GET /api/status`.
A heartbeat cannot target a hidden window. The Codex Spark bucket currently
uses `codex_bengalfox:primary`; configure this explicitly per account rather
than relying on a provider-name heuristic.

Every successful heartbeat is followed by a usage check. When that check
returns an authoritative next reset, Provider Pulse uses it. If the provider
temporarily omits the timestamp—or the follow-up poll fails after the model
request succeeded—the scheduler estimates the next reset from heartbeat
completion plus the normalized window duration (five hours or seven days in
the current adapters). Any later provider timestamp replaces that estimate.
On restart, a handled inactive window can recover the same estimate from its
persisted cursor rather than silently losing the next heartbeat.

Provider window availability can vary by account and plan. After every
successful usage check, an enabled heartbeat whose configured window or reset
time is absent becomes unhealthy with an explicit error instead of remaining
silently unscheduled.

## Run locally

```sh
npm run build
PROVIDER_PULSE_CONFIG="$HOME/.config/provider-pulse/config.json" npm start
```

The default page is <http://127.0.0.1:4317>. Provider Pulse should remain bound
to loopback; it has no remote-user authentication layer.

## HTTP API

Reading status is side-effect-free:

```text
GET /api/status
```

The response is one normalized JSON object containing overall health, account
identity and usage windows, the most recent usage-poll result, and all heartbeat
job states. It never starts a CLI, refreshes a token, or sends a model request.
When Codex reports banked resets, the account snapshot also contains:

```json
{
  "resetCredits": {
    "availableCount": 2,
    "credits": [
      {
        "id": "opaque-provider-id",
        "resetType": "codexRateLimits",
        "status": "available",
        "grantedAt": "2026-08-21T12:00:00.000Z",
        "expiresAt": "2026-08-28T12:00:00.000Z",
        "title": "Banked reset",
        "description": "Provider-supplied description"
      }
    ]
  }
}
```

`availableCount` is authoritative. `credits` is omitted when the provider
returns only a count, may be an empty array when details were fetched but none
exist, and may contain fewer records than the count when the provider caps the
detail response.

Actions are started with:

```text
POST /api/accounts/:accountId/check
POST /api/check-all
POST /api/usage-baseline/snapshot
POST /api/heartbeats/:heartbeatId/run
POST /api/heartbeat-all
```

Actions return operation receipts promptly. Poll `GET /api/status` to observe
progress and the final per-operation result. Duplicate checks are coalesced and
operations sharing a credential surface are serialized. Bulk actions preserve
individual outcomes.

The snapshot action never accepts usage values from the browser. It atomically
saves the server's current percentage-based readings. When no baseline exists,
the first successful usage check seeds each available window automatically.
Every percentage row shows the date and time when its current comparison
snapshot was captured.
Provider reset detection rebases only the affected account/window pair.

The web page exposes the same per-card and bulk actions. Heartbeats deliberately
have no confirmation modal, so treat the buttons as real quota-consuming
actions. Failed or timed-out heartbeats are not automatically retried because
the provider may have accepted a request whose response was lost.

The dashboard uses three columns on wide screens, two on medium screens, and
one on narrow screens. **Hide identities** replaces configured account labels,
emails, and organization text with `Redacted` while retaining provider and plan
context. The preference is stored in browser local storage. It is a display
privacy feature only: `GET /api/status` continues to return configured and
observed identity data to the trusted local caller.

Each normalized seven-day quota window also shows a seven-cell time-progress
bar. Completed 24-hour slices are filled, the current slice is partially filled,
and future slices remain empty. This is calculated from the provider-reported
reset and duration and does not require more polling or persisted history.

## How terminal usage polling works

Tmux supplies both the pseudo-terminal and terminal emulation. Provider Pulse
starts a uniquely named detached session with fixed dimensions and safe CLI
flags, waits for the prompt, sends literal `/usage` and Enter as separate key
operations, and polls `tmux capture-pane`. `capture-pane` reconstructs the
visible terminal text, so the parser reads a screen rather than raw ANSI escape
sequences from a pipe. After stable provider-specific completion markers are
seen, the text is parsed and the exact session is destroyed in a `finally`
cleanup path.

All subprocesses use argument arrays with shell expansion disabled and enforce
startup, response, output-size, and total time limits. Tmux is behind a small
terminal-probe boundary, so a future implementation could replace it with
`node-pty` plus a headless terminal emulator. Tmux is simpler here because it
already provides both pieces and exposes reconstructed text through
`capture-pane`.

Claude polling combines `claude auth status --json` identity data with the TUI
usage screen. Grok polling can leave an empty resumable native session even
though it sends no model prompt; that is a current CLI limitation.

## Run as a user service

The service example expects the recommended checkout path from the install
steps above. If the repository is elsewhere, edit `WorkingDirectory` and
`ExecStart` first. Then install and start it:

```sh
install -D -m 0644 deploy/provider-pulse.service.example \
  "$HOME/.config/systemd/user/provider-pulse.service"
systemctl --user daemon-reload
systemctl --user enable --now provider-pulse.service
systemctl --user status provider-pulse.service
```

The example resolves `node` through the user manager's `PATH`. If Node was
installed in a private location, replace `/usr/bin/env node` in `ExecStart`
with the absolute path reported by `command -v node`.

The long stop timeout is intentional: heartbeat jobs may run for up to their
configured 900-second limit. Graceful shutdown stops the reset scheduler, waits
for in-flight work, and then removes only Provider Pulse's private tmux server
and probes.

Inspect logs with:

```sh
journalctl --user -u provider-pulse.service -f
```

Restart the service after changing `config.json`. Dashboard status returns to
unknown and configured startup checks repopulate it. The small scheduler cursor
prevents duplicate post-reset heartbeats across restarts; diagnostic JSONL is
for troubleshooting only and is not replayed.

## Releases and upgrades

Provider Pulse uses semantic versions and publishes releases from annotated Git
tags. The repository intentionally does not commit `dist/`; each checkout is
built with its declared Node.js and npm dependencies.

- See [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
- See [docs/releases.md](docs/releases.md) for the maintainer release checklist,
  upgrade procedure, rollback procedure, and publication safety checks.

## Security notes

- Keep configuration, credential homes, state, and logs readable only by the
  local owner.
- Never put access tokens, refresh tokens, cookies, API keys, or auth-file
  contents in labels, prompts, or expected identity fields.
- Do not point monitoring surfaces at credential homes used concurrently by
  other applications.
- Keep the HTTP listener on `127.0.0.1`.
- A heartbeat is a real provider request. It can consume paid capacity, start a
  reset window, refresh a credential, and create a small provider-side session.

## License

Provider Pulse is available under the [MIT License](LICENSE).
