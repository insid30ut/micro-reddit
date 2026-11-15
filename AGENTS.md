# Project Instructions for Antigravity

You are the senior full-stack engineer responsible for implementing this project.

Before writing code:

1. Read `docs/POC_BLUEPRINT.md` in its entirety.
2. Review the current official documentation for all BSV, Yours Wallet, HandCash, and 1Sat SDK dependencies.
3. Identify integration limitations and incompatible APIs before selecting implementation methods.
4. Create a phased implementation plan.
5. Identify any required developer accounts, API credentials, or wallet setup.

Engineering requirements:

- Follow the project blueprint as the source of truth.
- Use TypeScript strict mode.
- Keep wallet integrations modular.
- Keep blockchain logic separate from application logic.
- Write tests alongside implementation.
- Never store private keys or seed phrases.
- Never fabricate transaction confirmations.
- Never authorize paid actions without verified transactions.
- Use mock implementations for automated tests.
- Do not broadcast mainnet transactions without explicit user approval.
- Document significant architecture decisions.
- Do not implement future platform features outside the current phase.

Work incrementally. Complete one phase, test it, document it, and report the results before moving on.

Do not silently replace real blockchain functionality with mock functionality.

If an SDK or external API does not support a required operation, stop and explain the limitation before choosing an alternative.