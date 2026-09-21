# after-flow Backend context

## What this product is

after-flow supports the organization of procedures after a death. The Backend is not an LLM wrapper: it owns formal business state, authorization, versioning, audit, evidence, consent policy, deadlines, and safe coordination with an independent AI service.

The Browser uses only the Backend public API for business traffic. The AI service receives scoped context/artifacts and returns proposals or results through authenticated internal HTTP. It must not access the business database or original-document Storage directly.

## Architecture map

The Backend is a strict TypeScript Hono service under `apps/backend-server`:

- `src/domain/`: entities, state transitions, catalogs, and rules without HTTP or Firestore concerns.
- `src/application/`: use cases, authorization, transaction boundaries, AgentRun/Outbox coordination, and ports.
- `src/infrastructure/`: Firestore, Storage, JWT/JWKS, catalog configuration, and Backend-to-AI HTTP adapters.
- `src/presentation/`: Hono routes, Zod schemas, envelopes, errors, and OpenAPI generation.
- `test/`: contract and unit tests.
- `test/firestore/`: Emulator integration tests for persistence and cross-service coordination.

Important sources:

- `docs/architecture.md`: target architecture and MVP/future distinction.
- `docs/api/public-openapi.yaml`: generated public contract; do not edit by hand.
- `docs/api/internal-openapi.yaml`: generated Backend/AI internal contract.
- `docs/api/frontend-backend-mapping.md`: migration from the existing UI/MSW behavior.
- `docs/adr/0001-authentication-provider.md`: real authentication remains a product decision.
- `docs/adr/0002-document-inspection.md`: inspection safety and unresolved provider/accuracy choices.
- `docs/adr/0003-execution-control.md`: AgentRun, Outbox, lease, wait/resume.
- `docs/adr/0004-confirmation-path.md`: Proposal, Approval, and Decision confirmation.
- `docs/runbooks/outbox-worker.md`: independent worker operation.

## Implemented baseline (2026-09-21 snapshot)

The core Backend foundation is implemented:

- JWT verification adapter, tenant membership, Case membership, and role authorization.
- Case, persons, relationships, assets, liabilities, contracts, benefits, documents, tasks, deadlines, evidence, insights, and overview APIs.
- Proposal versioning, Approval application,本人による Decision confirmation, stale checks, and Case versioning.
- AgentRun acceptance/status/cancel/retry, Outbox delivery logic, Case lease/fencing, WaitRequest, resume intent, and Reconciler.
- Chat and task-guidance asynchronous acceptance/result storage.
- Firestore Repository/UnitOfWork, cursor pagination, idempotency, atomic audit/outbox writes, and Security Rules denying direct client access.
- Local and Cloud Storage adapters, content signature and size validation, archive behavior, and inspection-state modeling.
- Route-spec-driven Swagger/OpenAPI and public/internal contract tests.
- Docker development for Web, Backend, AI, Firestore Emulator, and Storage Emulator.

This does not mean production readiness. In particular:

- The Outbox/Reconciler worker runs as an independent `outbox-worker` container in local Docker (`make up`, see `docs/runbooks/outbox-worker.md`), but the Cloud Run production deployment approach (standing worker vs. Job+Scheduler), production IAM/tenant assignment, and production monitoring wiring remain undecided (#122).
- Health is liveness; dependency readiness and production preflight are incomplete.
- A real authentication provider, approved consent catalog, and reviewed deadline catalog are not selected/configured.
- Real My Number detection/masking is not implemented. Only the port, state, quarantine contract, and `PASSED`-only delivery guard exist.
- AgentRun progress history and safe audit-log reads lack public APIs.
- Retention and periodic orphan cleanup are not implemented.

## Business and security invariants

- A Case ID alone grants no access. Verify tenant membership and Case membership without revealing another Case's existence.
- Updates use optimistic version checks. A stale AI proposal must not overwrite newer human changes.
- Approval binds to an immutable proposal version and content hash. Approval receipt and successful application remain distinct.
- A relative may report a Decision, but only the person-linked user can confirm that person's decision.
- Deadline dates come only from reviewed rules with recorded basis, version, jurisdiction, timezone, and source.
- External-AI consent is optional for manual features and is rechecked at delivery time.
- An uninspected, inspecting, rejected, or failed document is never sent to AI. A masking claim must not route the original as the ordinary analysis input.
- Archive/exclusion preserves references and audit. It is not equivalent to complete personal-data erasure.
- AI execution acceptance is asynchronous. `202` means queued, not completed.

## Common misconceptions

- Swagger availability does not mean authenticated business APIs are immediately testable; local token and membership bootstrap is a separate action.
- A passing `/health` response does not prove Firestore, Storage, authentication, catalogs, worker, Mastra, or Orch readiness.
- The existence of inspection tests with a fake inspector does not mean real detection/masking is delivered.
- Worker logic passing integration tests does not mean the worker is deployed or scheduled.
- The architecture's future API table is not automatically the runtime contract; current route specs and generated OpenAPI are the implemented contract.
