# Contributing

Thanks for helping improve the public Isogate contract package.

## Before opening a pull request

1. Read the relevant contract and its tests.
2. Keep changes narrowly scoped and explain security-sensitive behavior.
3. Add or update tests for changed invariants and failure paths.
4. Run the cheapest relevant checks locally:
   `pnpm --dir isogate-genesis run check`.
5. Do not include credentials, deployment state, generated artifacts, logs,
   node modules, or private operational material.

## Pull requests

Use a clear title and describe the security and compatibility impact. Include
reproduction steps for fixes. Avoid claims about audits, market performance,
decentralization, or production readiness unless independently documented and
reviewable.

By participating, you agree to follow the Code of Conduct.
