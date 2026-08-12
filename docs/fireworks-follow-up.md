# Fireworks integration

Status: implemented using the official Fireworks account, quota, and billing
summary APIs.

## Goals

The integration adds a Fireworks logical account without changing the
provider-neutral status, health, usage-window, action, or heartbeat contracts.
It reports the supported machine-readable usage information and truthfully
marks the API-unavailable prepaid balance as web-only.

## Supported surfaces

- `GET /v1/accounts/{account_id}` supplies account identity and state.
- `GET /v1/accounts/{account_id}/quotas` supplies monthly spend, configured
  budget, request-rate, GPU, and deployment quotas.
- `GET /v1/accounts/{account_id}/billing/summary` supplies exact rated costs for
  the current calendar month. Those line items are summed as monthly spend.
- The adapter presents monthly spend as currency, not as a percentage. Only a
  genuinely finite monthly budget is normalized to percent remaining.
- API credentials live in a dedicated `0600` file and are never copied into Pi.

If an API returns only monthly spend and a spend limit, expose a computed value
as `budget remaining`; never call it a prepaid cash or credit balance. If no
supported balance field exists, return `unavailable` rather than zero or an
estimate.

## Implementation

- The strict `fireworks-api` surface accepts only an absolute credential-file
  path. Startup requires a regular nonempty file with owner-only permissions.
- Each Fireworks account requires `expectedIdentity.accountId`; the adapter
  requests exactly that account and verifies the returned account ID and email.
- Requests use bounded timeouts and response sizes. Authentication, HTTP,
  account-state, and schema-drift failures have stable error codes.
- No Fireworks heartbeat is provided. The card has only usage polling actions.

## Pi heartbeat semantics

Fireworks authenticates with an API key rather than OAuth. Provider Pulse does
not create a Pi Fireworks heartbeat: it would be a billable inference test, not
credential-refresh maintenance.

No Fireworks-specific branch is added to the generic Pi executor.

## Acceptance criteria

- Fireworks remains absent when it is not configured.
- Existing providers and normalized API shapes do not change.
- Remaining balance is truthful: actual prepaid balance, explicitly computed
  budget remaining, or unavailable.
- No key, authorization header, full auth payload, or credential path is
  exposed in status, errors, or logs.
- Manual and bulk usage checks preserve independent operation results.
- Any configured heartbeat clearly warns that it performs billable inference.
