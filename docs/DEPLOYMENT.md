# Deploying the E-kimina API

## What you need

- Node.js 20, pnpm 9
- PostgreSQL 14+ (16 recommended) with daily backups
- HTTPS in front of the API (nginx, Caddy or a load balancer)
- Optional services: SMTP, an SMS provider (Africa's Talking or an HTTP gateway), MTN MoMo API
  credentials, Cloudinary (payment proofs and photos), Sentry or GlitchTip

## Configure

Copy [`.env.example`](../.env.example) to `.env` and fill it in. At minimum in production:

| Variable | Why |
|---|---|
| `NODE_ENV=production` | JSON logs, Secure cookies, HSTS, MoMo mock refused |
| `DATABASE_URL` | PostgreSQL connection |
| `JWT_SECRET` | long random value (`openssl rand -base64 48`); changing it signs everyone out |
| `PAYMENT_SECRETS_KEY` | encrypts group MoMo keys and the push key (`openssl rand -base64 32`); keep it with your secrets, losing it means re-entering those keys |
| `CORS_ORIGINS` | the web app origin(s), e.g. `https://app.ekimina.rw` |
| `FRONTEND_URL` | used in email links |
| `TRUST_PROXY=1` | real client IPs in audit logs and rate limits behind a proxy |
| `SMTP_*` and/or `SMS_PROVIDER` | sign-up codes need at least one of them |
| `MOMO_*` | `MOMO_MODE=production`, credentials, `MOMO_CALLBACK_BASE_URL=https://<api-host>/api` |
| `SENTRY_DSN` | error reports |

Cookies: if the web app and API are on **different sites** (not just subdomains), set
`COOKIE_SAMESITE=None` (HTTPS required). Same site (e.g. `app.ekimina.rw` and `api.ekimina.rw`) works
with the default `Lax`.

## Build and run

```bash
pnpm install --frozen-lockfile
pnpm exec prisma generate
pnpm exec prisma migrate deploy      # every deploy, before starting the new version
pnpm run build
node dist/main.js                    # behind a process manager (systemd, pm2, Docker)
```

First install only: `pnpm exec prisma db seed` creates roles and the first super admin (change its
password right away). The demo group seed (`prisma/newseed.ts`) is for development and staging only.

### Several instances

The job queue lives in PostgreSQL, so any number of API instances can run. Keep
`FINANCE_JOBS_ENABLED=true` on **one** instance only (daily scheduler). Set `JOBS_WORKER_ENABLED=false`
on instances that should only serve HTTP. Rate limits are per instance; put a shared limiter in front
(or at the proxy) if you need global limits.

## Health and monitoring

| Endpoint | Use |
|---|---|
| `GET /api/health/live` | liveness probe (process answers) |
| `GET /api/health/ready` | readiness probe (database reachable; 503 otherwise) |
| `GET /api/health` | full report: database, SMTP, Cloudinary, SMS, MoMo, job queue (`degraded` when an optional service fails; 503 only when the database is down) |

- Logs: one JSON object per line on stdout/stderr (`LOG_FORMAT=json`), with `requestId`. Every HTTP
  request gets an access line (method, path, status, ms, user). Ship them to your log store.
- Errors: unexpected failures are reported to `SENTRY_DSN` with the request id and user id.
- Job queue: super admins see backlog and failures in the web app (Platform → Jobs) or
  `GET /api/admin/jobs`; dead jobs can be retried. `/api/health` turns `degraded` if jobs died in the last
  24 hours or the queue lags more than 5 minutes.

## Backups (financial data)

```bash
# nightly, keep 14 days locally; encrypt and copy off the server
DATABASE_URL=… BACKUP_DIR=/var/backups/ekimina BACKUP_GPG_RECIPIENT=ops@example.com \
BACKUP_UPLOAD_CMD='aws s3 cp {file} s3://ekimina-backups/' scripts/backup.sh

# monthly restore drill: restores the newest dump into a scratch database and checks it
DATABASE_URL=… BACKUP_DIR=/var/backups/ekimina scripts/restore-drill.sh
```

`backup.sh` makes a compressed `pg_dump` custom archive, checks it can be read, writes a SHA-256 file,
optionally encrypts (GPG) and uploads, and prunes old local copies. `restore-drill.sh` restores into a
throw-away database, compares row counts and fund balances with the live database, checks the
migrations table, allocation integrity and that no fund is negative, then drops the copy. Run it
monthly and after every PostgreSQL upgrade; write down the restore time.

Also enable your provider's point-in-time recovery (WAL archiving) if available: nightly dumps alone
can lose up to a day of payments.

## Security checklist

- HTTPS only; `COOKIE_SECURE` on; `SWAGGER_ENABLED=false` unless needed
- Strong `JWT_SECRET` and `PAYMENT_SECRETS_KEY`, stored as secrets (not in the repo)
- Database user without superuser rights; backups encrypted off-site
- Consider turning on Platform → Settings → "leaders must use two-step verification"
- Watch `/api/health`, the job queue and the audit log
