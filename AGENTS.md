# after-flow

Architecture source: [docs/architecture.md](docs/architecture.md).

- Use pnpm workspaces and strict TypeScript. Keep the lockfile committed.
- Preserve existing React UI behavior, routes, and MSW fixtures during structural changes.
- Web may import only public-contracts from other workspaces; browser business traffic goes through the Backend public API.
- Backend and AI are independent Hono services. Do not import the other service's source or repositories.
- Formal business state belongs to Backend Application/Domain; AI submits proposals through authenticated internal HTTP APIs.
- AI must not receive business Firestore or original-document Storage credentials.
- Mastra/Orch integrations are not implemented yet. Do not claim readiness from the liveness endpoints.
- Create future directories when implementing their responsibilities; do not generate empty stubs for the entire target tree.
- Validate changes with `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm openapi:check`, `pnpm build`, or Docker-only `make check`.
- Public API routes are defined once and drive both runtime validation and `docs/api/public-openapi.yaml`. Regenerate with `pnpm openapi:generate`.
- Business Firestore belongs to Backend only. Never give the AI service Firestore or original-document settings, env vars, or networks.
- Persistence changes need Emulator coverage: `pnpm test:firestore`. Do not mark unverified behavior as passing.
- For Docker changes, run `make up`, verify all three health checks and the mock UI, and keep AI ports unpublished.
