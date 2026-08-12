# Changelog

All notable changes to Provider Pulse are documented here. The project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Dashboard quota bars now retain their first sample for the lifetime of the
  page and show capacity consumed since then as a muted comparison segment.

### Fixed

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
