---
description: Run Prisma validation, TypeScript strict typecheck, and Vitest test suite
---

# Run Verification & Tests

1. Validate Prisma schema and generated client:
   ```bash
   npm run db:generate
   npm run db:validate
   ```
2. Run TypeScript strict mode verification:
   ```bash
   npm run typecheck
   ```
3. Execute automated unit and integration tests:
   ```bash
   npm test
   ```
