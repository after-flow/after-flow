# Backend next actions

This is a planning snapshot from 2026-09-21. Before implementing, refresh the live state:

```sh
gh issue view 131 --repo after-flow/after-flow
gh issue list --repo after-flow/after-flow --state open --label backend
```

Parent tracking Issue: [#131](https://github.com/after-flow/after-flow/issues/131).

## Ready implementation work

| Issue | Outcome | Main verification |
|---|---|---|
| [#121](https://github.com/after-flow/after-flow/issues/121) | Firestore Emulator runner no longer hangs and emits actionable diagnostics | Supported Node version; three successful CI runs |
| [#123](https://github.com/after-flow/after-flow/issues/123) | Backend readiness fails closed when required dependencies/configuration are missing | readiness tests plus deployment smoke |
| [#124](https://github.com/after-flow/after-flow/issues/124) | A developer can authenticate, seed membership, and call business APIs from Swagger locally | `make up`, token/seed flow, production guard |
| [#125](https://github.com/after-flow/after-flow/issues/125) | Users can retrieve safe, ordered AgentRun progress history | Emulator isolation/idempotency tests and OpenAPI |

These Issues carry `Devin` because their implementation conditions are sufficiently defined. Recheck dependencies and acceptance criteria before starting.

## Implementation needing an operational or policy choice

| Issue | Decision before or during implementation |
|---|---|
| [#122](https://github.com/after-flow/after-flow/issues/122) | Local Docker connection (compose `outbox-worker` service, restart/duplicate/consent-revocation/backlog smoke tests) is done. Still undecided: Cloud Run production deployment shape (standing worker vs. Job+Scheduler), production tenant assignment, production monitoring wiring. |
| [#126](https://github.com/after-flow/after-flow/issues/126) | Which audit events/details each Case role may read |
| [#130](https://github.com/after-flow/after-flow/issues/130) | Retention periods, erase/archive semantics, dry-run approval |

Do not invent these product, legal, or operations policies merely to unblock code. Record the decision in the Issue/ADR, then make the implementation task concrete.

## Decision-first work

| Issue | Required owner/input |
|---|---|
| [#127](https://github.com/after-flow/after-flow/issues/127) | Identity/security and Frontend: provider, issuer/audience/JWKS, tenant claim, refresh/revocation |
| [#128](https://github.com/after-flow/after-flow/issues/128) | Business/legal/security: production terms, privacy, external-AI disclosure and retention |
| [#129](https://github.com/after-flow/after-flow/issues/129) | Business/legal: reviewed deadline rules, sources, jurisdiction, dates, review cadence |
| [#25](https://github.com/after-flow/after-flow/issues/25) | Business/security/engineering: document detection, OCR, masking, retention, error thresholds |

Do not add the `Devin` label or start a production implementation until the listed decision is explicit.

## Document-inspection chain

- [#19](https://github.com/after-flow/after-flow/issues/19): parent scope and safety contract.
- [#25](https://github.com/after-flow/after-flow/issues/25): select the real inspection/masking approach and validation criteria.
- [#26](https://github.com/after-flow/after-flow/issues/26): implement the selected adapter with synthetic documents only.
- [#27](https://github.com/after-flow/after-flow/issues/27): verify every context/artifact/delivery/resume path allows only the approved inspected version.

Some `PASSED`-only guard tests already exist. That partial coverage does not unblock #26 or complete #27 without a real adapter, reinspection/version behavior, and the selected masking contract.

## Recommended execution order

1. Restore a stable green signal with #121.
2. Make accepted work actually run and expose true readiness with #122 and #123.
3. Improve developer verification with #124.
4. Add user-visible execution/audit history through #125 and, after its policy decision, #126.
5. Resolve production identity, consent, and deadline decisions (#127–#129).
6. Complete document inspection (#25 → #26 → #27) and data lifecycle (#130).

Independent tasks may proceed in parallel, but do not merge a dependent Issue before its decision or contract is settled.

## Handoff template

For a new developer, provide:

1. Issue URL and why it matters to product behavior.
2. Current implementation that should be extended rather than replaced.
3. Explicit in-scope and out-of-scope boundaries.
4. Relevant ADR/runbook/route spec and likely code entrypoints.
5. Acceptance criteria, including negative security cases.
6. Exact required checks, especially `pnpm test:firestore` for persistence and `pnpm openapi:check` for routes.

Ask the developer to report unverified production behavior separately rather than treating local liveness or mocked tests as readiness.
