---
name: after-flow-backend-development
description: Build, review, test, and explain the after-flow Backend Hono service. Use for Backend public APIs, business state, Firestore persistence, document storage, authentication and authorization, AgentRun/Outbox execution control, operational readiness, Backend issue planning, and onboarding. Do not use for AI runtime internals or Frontend UI work except when coordinating their HTTP contracts.
---

# After Flow Backend Development

Work from the repository root. Read the repository `AGENTS.md` completely before changing code; its architecture and validation rules are authoritative.

## Orient the work

Use sources in this order when they disagree:

1. `AGENTS.md`
2. `docs/architecture.md`
3. Runtime route specs and generated OpenAPI
4. ADRs and runbooks under `docs/`
5. The current GitHub Issue and its dependencies
6. README summaries

Read [references/backend-context.md](references/backend-context.md) when explaining the project, reviewing architecture, or entering an unfamiliar Backend area. Read [references/next-actions.md](references/next-actions.md) when choosing work, preparing a handoff, or implementing Issues #121–#131. The action list is a dated snapshot; refresh live Issue state before acting.

Classify the request before implementation:

- Public API or business behavior: trace route spec → schema → Application service → Domain rule → port/adapter → Emulator test.
- Persistence: preserve tenant/Case paths, transaction atomicity, version checks, audit, outbox, and idempotency.
- AI integration: change only authenticated internal HTTP contracts and Backend-owned execution state. Never import AI service source.
- Operations: distinguish process liveness, dependency readiness, worker execution, deployment, and monitoring.
- Document inspection: preserve quarantine and `PASSED`-only delivery; do not simulate a real inspection capability.

## Preserve the service boundaries

- Backend is the single writer for formal Case, Task, Document, Proposal, Approval, Decision, and AgentRun state.
- AI submits typed proposals/results through authenticated internal HTTP. It receives neither business Firestore nor original-document Storage credentials, settings, or network access.
- Derive `tenantId`, Case scope, actor, role, and allowed operation from authenticated Backend state. Never trust them from a request body or AI claim.
- Require `Idempotency-Key` on writes and the relevant `expectedVersion` or `baseCaseVersion` for existing state.
- Apply entity changes, audit events, outbox events, and idempotency results in one Firestore transaction. Perform no external HTTP, LLM, queue, or Storage I/O inside a retryable transaction.
- Keep user Commands, AI Proposals, human Approvals, and本人による Decision confirmation distinct. AI output alone never confirms formal state.
- Treat liveness as process health only. Missing Firestore, Storage, authentication, catalogs, worker, Mastra, or Orch integration must not be described as ready.
- Only actual inspection may set a document to `PASSED`. Do not use filename checks, fixed-success fakes, or extension checks as inspection completion.
- Keep placeholder consent and deadline catalogs out of production. Preserve the existing fail-closed checks.

## Implement a vertical slice

1. Inspect `git status` and preserve unrelated work, especially current AI changes.
2. Read the target Issue, parent Issue, dependencies, ADR, and relevant tests. Confirm that decision-blocked work is actually unblocked.
3. Inspect existing patterns before adding files. Add only directories whose responsibility is being implemented.
4. Define or update the route spec once. Reuse it for runtime validation and OpenAPI generation.
5. Put authorization and business rules in Application/Domain, not only in a route handler.
6. Extend ports before adapters when new infrastructure behavior is required.
7. Add negative tests for tenant/Case isolation, role, stale versions, duplicate requests, and forbidden AI access as applicable.
8. Update ADRs, runbooks, mapping documents, or environment examples when the operational contract changes.

Do not close an Issue merely because the happy path works. Satisfy every acceptance condition or clearly report the remaining condition.

## Validate proportionally

Always run the smallest relevant tests while iterating. Before handoff, use the repository commands required by the change:

- Ordinary Backend code: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.
- Public or internal route contract: also run `pnpm openapi:check`; regenerate with `pnpm openapi:generate` when intended.
- Firestore, transaction, cursor, worker ledger, or persistence behavior: run `pnpm test:firestore`. Never report persistence as passing without it.
- Docker or environment changes: run `make up`, verify Web, Backend, AI health, Swagger/mock UI, `make data-check`, and confirm AI ports remain unpublished. Stop with `make down` when appropriate.
- Docker-only environments: `make check` covers the ordinary quality suite but does not replace required Emulator coverage.

Record exact commands and results. Separate a product limitation, missing configuration, skipped test, and actual failure.

## Hand off clearly

Lead with the outcome. Include:

- What became possible and what remains unavailable.
- The Issue and acceptance criteria completed.
- Important files and contracts changed.
- Tests run and any unsupported local runtime warning.
- Remaining decisions or production-only verification.

When onboarding another developer, explain the stable architecture first, then assign one unblocked Issue from the current action list with its dependencies and completion checks.
