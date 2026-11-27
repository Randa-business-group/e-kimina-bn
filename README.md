# E-kimina API

NestJS 11 + Prisma 7 + PostgreSQL back end for E-kimina, a platform for Rwandan savings groups
(*ibimina*): contributions, fines, loans with installments and guarantors, the group cash book,
cycles and share-out, meetings and votes, reports, notifications (in-app, email, SMS, push) and
platform administration. The web app lives in `../e-kimina-fn`.

## Quick start (development)

```bash
pnpm install
cp .env.example .env          # set DATABASE_URL and JWT_SECRET at least
pnpm exec prisma migrate deploy
pnpm exec prisma db seed      # roles, super admin, and a demo group with a year of history
pnpm run start:dev            # http://localhost:4033/api  (docs at /api/docs)
```

Without SMTP, SMS and MoMo settings the app uses simulated providers in development (`SMS_PROVIDER=mock`,
`MOMO_MODE=mock`); super admins can read mock texts at `GET /api/admin/sms-logs/mock-inbox`.

## Scripts

| Command | What it does |
|---|---|
| `pnpm run start:dev` | run with reload |
| `pnpm run build` / `node dist/main.js` | production build / run |
| `pnpm exec eslint "src/**/*.ts" "test/**/*.ts"` | lint |
| `pnpm test` | unit tests (money rules, security, notifications …) |
| `pnpm run test:e2e` | end-to-end money flow against `DATABASE_URL` (migrated + seeded) |
| `pnpm exec prisma migrate deploy` | apply migrations |
| `scripts/backup.sh`, `scripts/restore-drill.sh` | backups and restore drill |

CI (`.github/workflows/ci.yml`) runs lint, type-check, unit tests, migrations on an empty database, a
schema drift check, the seed, the end-to-end flow and the build on every push and pull request.

## Documentation

- [docs/API.md](docs/API.md) — authentication, tokens, errors, idempotency, rate limits, resource map
- [docs/PERMISSIONS.md](docs/PERMISSIONS.md) — what each role may do
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — configuration, running, health, backups, security
- [.env.example](.env.example) — every environment variable
- `../msfts.md` — feature status and history

## Layout

```
src/auth            sign-in, sessions, two-step, account
src/groups          groups, members, verification
src/group-finance   deposits, MoMo, loans, fines, daily jobs
src/group-accounting  ledger, cycles, share-out, expenses, social fund, rotation
src/group-governance  roles, exits, meetings, constitution, polls
src/finance-core    money rules (allocation, schedules, eligibility, ledger)
src/reports         statements and reports (JSON/CSV/PDF)
src/notifications   in-app, email, SMS, push, announcements
src/admin, platform, audit   super-admin tools, platform settings, audit log
src/jobs            background job queue (PostgreSQL)
src/common          observability, rate limits, security helpers
prisma/             schema, migrations, seeds
test/               end-to-end tests
```
