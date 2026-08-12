# Fireworks follow-up

Fireworks is deliberately excluded from the initial Provider Pulse runtime.
Codex, Claude, and Grok should stabilize before this adapter is added.

## Goals

The follow-up should add a Fireworks logical account without changing the
provider-neutral status, health, usage-window, action, or heartbeat contracts.
It should report the best supported machine-readable usage information and, if
available, the user's actual remaining prepaid balance.

## Discovery work

Before implementation, verify the current official Fireworks surfaces and
their authentication, response schemas, pagination, rate limits, and failure
modes:

1. Evaluate `firectl quota list --output json` and the equivalent List Quotas
   API for rate limits, GPU quotas, monthly spend limit, and usage.
2. Evaluate official billing exports or summaries for spend details.
3. Confirm whether Fireworks exposes a supported machine-readable prepaid
   credit balance. The web dashboard showing a balance is not itself a stable
   API contract.
4. Capture redacted fixtures for positive, exhausted, missing, unauthorized,
   and schema-drift responses.

If an API returns only monthly spend and a spend limit, expose a computed value
as `budget remaining`; never call it a prepaid cash or credit balance. If no
supported balance field exists, return `unavailable` rather than zero or an
estimate.

## Proposed implementation

- Add a structured Fireworks usage adapter using the official CLI or API.
- Normalize quotas and billing periods as ordinary usage windows and balances.
- Return safe account identity metadata when a stable account or organization
  identifier is available.
- Use bounded timeouts, output limits, stable error codes, and secret redaction.
- Keep API keys exclusively in their owning credential surface; never return
  them through status or logs.
- Add parser/schema fixtures, config validation, action API coverage, identity
  mismatch behavior, and dashboard states.

## Pi heartbeat semantics

Fireworks currently authenticates Pi with an API key rather than OAuth. The
generic Pi executor can eventually target a Fireworks provider/model tuple, but
that heartbeat would be an end-to-end inference availability check—not OAuth
credential-refresh maintenance. It consumes metered inference usage and should
be labeled accordingly.

No Fireworks-specific branch should be added to the generic Pi executor. The
full provider, model, reasoning, prompt, credential surface, and trigger remain
ordinary configuration.

## Acceptance criteria

- Fireworks remains absent when it is not configured.
- Existing providers and normalized API shapes do not change.
- Remaining balance is truthful: actual prepaid balance, explicitly computed
  budget remaining, or unavailable.
- No key, authorization header, full auth payload, or credential path is
  exposed in status, errors, or logs.
- Manual and bulk usage checks preserve independent operation results.
- Any configured heartbeat clearly warns that it performs billable inference.
