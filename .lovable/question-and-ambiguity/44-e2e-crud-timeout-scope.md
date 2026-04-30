# 44 — E2E CRUD timeout scope

## Original task
User reports the same CI failure recurring: `e2e-02-project-crud.spec.ts` project CRUD tests time out at 60000ms and asks why it keeps happening and to fix it.

## Point of confusion
Two different problems can produce the same visible CI error:

1. The CI run is executing an older commit, because the reported failing line numbers and `60000ms` timeout do not match the current local spec/config.
2. The current custom Playwright extension fixtures still spend too much time in setup before per-spec timeout changes take effect.

## Options considered

### Option A — Only tell the user to rerun CI on the latest commit
- Pros: Matches the evidence that the log is stale.
- Cons: Does not harden the test fixture against future fixture-level timeout consumption.

### Option B — Harden the shared extension fixtures as well
- Pros: Addresses the known Playwright behavior where fixtures count against test timeout; makes the fix apply before `context` / `extensionId` setup; keeps the CRUD UI test intact.
- Cons: Does not by itself prove a stale CI run has picked up the new commit.

### Option C — Replace CRUD UI tests with direct storage/message API tests
- Pros: Fast and less flaky.
- Cons: Reduces coverage of the actual Options UI workflow the spec is meant to protect.

## Recommendation used
Proceed with **Option B**. The repeated 60s log is probably stale, but fixture-level timeout hardening is the safest code change that preserves the intended UI coverage and explains why prior edits may not have affected setup timing.
