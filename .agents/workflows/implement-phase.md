---
description: Incrementally implement and verify a single project phase from docs/POC_BLUEPRINT.md
---

# Implement Phase Workflow

1. Review the target phase tasks and acceptance criteria in `docs/POC_BLUEPRINT.md` and `AGENTS.md`.
2. Verify all required types, schemas, and interfaces before writing implementation code.
3. Implement only the current phase scope in strict TypeScript mode (`App Mode = mock` by default).
4. Write unit and integration tests covering all new logic and security constraints.
5. Run `npm run db:validate`, `npm run typecheck`, and `npm test`.
6. Update project documentation and stop for user review before starting the next phase.
