# Contributing

Thanks for contributing to Vexis Trading Agents.

## Prerequisites

- Node.js 20+
- npm 10+
- A local `.env` based on `.env.example`

## Setup

```bash
npm install
cp .env.example .env
npm run build
npm run validate
```

## Development Workflow

1. Create a branch from `main`.
2. Make focused changes with clear commit messages.
3. Run checks before opening PR:
   - `npm run build`
   - `npm run validate`
4. Open PR with:
   - summary of changes
   - test evidence
   - risk/regression notes

## Coding Guidelines

- Keep inter-agent and runtime payloads JSON-safe and strongly typed.
- Avoid breaking existing contracts unless explicitly planned.
- Prefer deterministic behavior in pipeline and validation scripts.
- For external providers (CCXT, APIs), add clear error codes and telemetry.
- Keep CLI output user-friendly and machine-readable with `--json`.

## Pull Request Checklist

- [ ] Build passes (`npm run build`)
- [ ] Validation passes (`npm run validate`)
- [ ] Docs updated (`README.md` / env docs if needed)
- [ ] New env vars added to `.env.example`
- [ ] Backward compatibility considered

## Reporting Bugs

Use GitHub Issues and include:

- command(s) executed
- configuration context (sanitized)
- expected behavior
- actual behavior
- logs/error output
