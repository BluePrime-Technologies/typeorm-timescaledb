# Contributing

Thanks for your interest. This project is built primarily for BluePrime's own
use, but contributions are welcome.

## Development

```bash
corepack enable
pnpm install
pnpm build
pnpm test
```

- **Node:** >= 20.19 or >= 22.12
- **Package manager:** pnpm (via corepack)
- Integration tests require Docker (Testcontainers spins up a real TimescaleDB).

## Ground rules

1. **Every change ships with tests.** No feature, fix, or change merges without
   tests covering happy paths, error cases, and edge cases.
2. **No global mutation.** Nothing may patch `DataSource.prototype`, `Repository.prototype`,
   or any shared global. The two-DataSource isolation test must stay green.
3. **No destructive rollbacks.** Migration `down()` must never delete data.
4. **Conventional Commits.** Commit messages follow
   [Conventional Commits](https://www.conventionalcommits.org/) — they drive releases.

## License & DCO sign-off

This project is licensed under **Apache-2.0** (see `LICENSE` and `NOTICE`). By contributing, you
agree your contributions are licensed under Apache-2.0 (its §3 grants a patent license).

Sign off every commit with the [Developer Certificate of Origin](https://developercertificate.org/) —
add a `Signed-off-by` trailer (`git commit -s`):

```
Signed-off-by: Your Name <you@example.com>
```

## Pull requests

- Open an issue first; reference it in the PR.
- Keep PRs focused. CI (lint, typecheck, unit, integration matrix) must be green.
