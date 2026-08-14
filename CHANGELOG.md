# Changelog

All notable changes to Provider Pulse are documented here. The project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Seven-day quota windows now include a seven-cell elapsed-time bar, with the
  current day partially filled toward the provider-reported reset.
- Dashboard quota bars show capacity consumed since an owner-only,
  server-persisted snapshot. A global action replaces the snapshot, first
  successful readings seed missing baselines, and provider resets rebase only
  the affected quota window.
- Each percentage row displays when its comparison snapshot was captured.

### Fixed

- Reset-aware heartbeats now retain a duration-based next-reset estimate when
  the immediate post-heartbeat usage poll omits or fails to return `resetsAt`.
  Later provider timestamps replace the estimate, and startup repairs handled
  inactive windows without overwriting newer scheduler state.
- Prevented reset-aware scheduler verification polls from deadlocking when
  they report their observed reset back to the scheduler mutation queue.
- Treated fully reset, inactive provider windows without a reset timestamp as
  eligible for their already-observed reset instead of reporting them as
  unhealthy.
- Placed Claude's positional heartbeat prompt before the variadic
  `--mcp-config` option so it is not misread as a configuration filename.

## 0.1.0 - 2026-08-12

Initial release.

### Added

- Compact local dashboard and normalized JSON status API.
- Multiple isolated Codex, Claude, and Grok account monitors.
- Structured Codex usage polling and tmux-backed Claude and Grok polling.
- Manual, bulk, and reset-aware native CLI and Pi heartbeats.
- Expected-identity checks, bounded diagnostics, and owner-only local state.
- Optional structured Fireworks account, quota, and monthly-spend polling.
- Hardened loopback action API and systemd user-service example.
