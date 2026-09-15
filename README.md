# Isogate API

Standalone TypeScript API workspace for bounded deterministic replay, provider
jobs, agent control, and optional chain-indexed Genesis routes. The repository
contains the API implementation, its OpenAPI document and generated Zod
schemas, PostgreSQL/Drizzle schema and migrations, and the deterministic replay
library.

This export is source-only: generated build output, dependency directories,
database contents, logs, credentials, and deployment configuration are
intentionally omitted. Chain and artifact-upload routes require an operator to
configure and review their own infrastructure. A replay digest is an API
result, not an on-chain or cryptographic proof.

## Layout

| Path | Purpose |
| --- | --- |
| `apps/api-server` | Express API application and production bundle |
| `packages/api-spec` | OpenAPI 3.1 document and Zod code-generation config |
| `packages/api-zod` | Generated request and response schemas |
| `packages/db` | Drizzle PostgreSQL schema and SQL migrations |
| `packages/replay` | Bounded deterministic CPU replay implementation |

## Requirements

- Node.js 22 or newer
- pnpm 10 or newer
- PostgreSQL for routes that persist state

## Install and check

```sh
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
```

Copy `.env.example` to `.env` for local configuration. The example contains
placeholders only; never commit `.env` or any signing key.

## Run the API

```sh
pnpm --filter @isogate/api-server start
```

The server listens on `PORT` and mounts routes below `/api`. A minimal health
check is available at `GET /api/healthz`. The database package fails closed
when `DATABASE_URL` is missing, so configure PostgreSQL before starting routes
that import persistence.

## API specification

The canonical document is `packages/api-spec/openapi.yaml`. Generated Zod
schemas in `packages/api-zod/src/generated` are checked in so consumers can
type-check without running code generation. Regenerate them with:

```sh
pnpm --filter @isogate/api-spec install
pnpm --filter @isogate/api-spec run codegen
```

Review generated changes alongside the OpenAPI change that caused them.

## Database

Migrations in `packages/db/migrations` contain schema changes only. Apply them
with the migration tooling selected by your deployment process; this export does
not include a database dump or seed data.

## Security and limitations

Read [SECURITY.md](../SECURITY.md) for responsible disclosure guidance.
Credentials are returned once by provider and agent registration flows and
must be handled as secrets by the caller. The deployment-proof and chain
integration paths are configuration-dependent and fail closed when required
settings are absent. This repository makes no claim of decentralization,
independent audit, production readiness, or market performance.

## License

MIT. See [LICENSE](../LICENSE).