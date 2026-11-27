# E-kimina API — usage guide

Interactive reference: **`/api/docs`** (Swagger, when `SWAGGER_ENABLED=true`). This guide explains
the conventions every client needs.

Base URL: `https://<host>/api`. All bodies are JSON unless noted.

## Signing in

| Step | Call |
|---|---|
| Email or phone + password | `POST /auth/login` `{ "email": "…" , "password": "…" }` or `{ "phone": "0788…", "password": "…" }` |
| Phone + SMS code | `POST /auth/phone/request-code` `{ "phone" }` → `POST /auth/phone/verify` `{ "phone", "code" }` |
| Two-step (if on) | login answers `{ "twoFactorRequired": true, "method": "TOTP" | "SMS", "challengeToken" }` → `POST /auth/2fa/verify` `{ "challengeToken", "code" }` or `{ "challengeToken", "recoveryCode" }` |
| Sign up | `POST /auth/register` → code by email and/or SMS → `POST /auth/verify-email` `{ "email", "otp" }` |
| Password reset | `POST /auth/forgot-password` → `POST /auth/reset-password/verify-otp` → `POST /auth/reset-password/complete` |

A successful sign-in returns `{ "accessToken", "user" }` and sets the refresh cookie.

### Tokens

- **Access token**: JWT, 15 minutes (`ACCESS_TOKEN_TTL`). Send `Authorization: Bearer <token>`.
- **Refresh token**: httpOnly cookie `ek_rt` scoped to `/api/auth`, 30 days, rotated on every use.
  `POST /auth/refresh` (no body) returns a new access token. Browsers must call it with
  `credentials: "include"` from an origin listed in `CORS_ORIGINS`.
- **Mobile / server clients** that cannot keep cookies send `X-Token-Transport: body`; the refresh token
  is then returned in the body and accepted as `{ "refreshToken" }` by `/auth/refresh` and `/auth/logout`.
- Reusing an already-rotated refresh token revokes that device's whole session family.
- `POST /auth/logout` signs out this device; `POST /auth/logout-all` every device;
  `GET /users/me/sessions`, `DELETE /users/me/sessions/:id` manage devices.

## Errors

```json
{ "statusCode": 400, "message": "Requested amount must not exceed 150000 RWF …", "error": "Bad Request" }
```

`message` is written for end users and safe to show. Validation errors return `message` as an array.
Unexpected failures return `500` with `requestId`; quote it to support.

Every response carries **`X-Request-Id`** (send your own to correlate logs).

## Idempotency (payments and loan requests)

`POST /groups/:id/finance/deposits` and `POST /groups/:id/finance/loan-applications` accept an
**`Idempotency-Key`** header (or `idempotencyKey` in the body). Generate one per user action (UUID) and
reuse it on retries: the second call returns the first result (`"replayed": true` for loans) instead of
creating a duplicate. A key used by another user is refused.

## Rate limits

`429 Too Many Requests` with `Retry-After` (seconds). Sign-in and code checks count failed attempts only
(10 per 15 minutes per IP and account); code requests (forgot password, SMS codes) 5 per 15 minutes;
600 requests per minute per IP overall.

## Money and dates

- Amounts are numbers in the group currency (`currency` field, usually `RWF`, no decimals in practice).
- Dates are ISO 8601 UTC. Report filters take `?from=YYYY-MM-DD&to=YYYY-MM-DD`.
- Reports can be downloaded with `?format=csv` or `?format=pdf`.

## Main resources

| Area | Endpoints |
|---|---|
| Me | `GET /users/me`, `PATCH /users/me`, `/users/me/finance/*` (summary, history, upcoming, dashboard), `/users/me/notifications`, `/users/me/notification-preferences`, `/users/me/security`, `/users/me/2fa/*`, `/users/me/data-export`, `/users/me/deletion-request` |
| Groups | `GET/POST /groups`, `GET/PATCH/DELETE /groups/:id`, members, join, invite, verification request |
| Money | `/groups/:id/finance/*`: deposit preview, deposits (MoMo or manual proof), confirm/reject, fines, loan preview, loan applications, approve/reject, member loans, statements |
| Rules | `PUT /groups/:id/contribution-config`, `PUT /groups/:id/loan-config`, `/groups/:id/governance/settings` |
| Accounting | `/groups/:id/accounting/*`: summary, ledger, cycles, share-out, expenses, social fund, rotation |
| Governance | `/groups/:id/governance/*`: roles, join requests, exits, meetings, constitution, polls, invitations |
| Reports | `/groups/:id/reports/*`: statement, contribution matrix, arrears, loan portfolio, cash book, share-out, receipts, dashboard |
| Announcements | `GET/POST /groups/:id/announcements` |
| Audit | `GET /groups/:id/audit-log` (leaders), `GET /admin/audit-logs` (super admin) |
| Platform | `/admin/users`, `/admin/groups`, `/admin/platform-settings`, `/admin/reports/platform`, `/admin/sms-logs`, `/admin/jobs`, `/admin/deletion-requests` |
| Public | `GET /platform/settings`, `GET /health`, `/health/live`, `/health/ready` |
| Provider callbacks | `PUT/POST /payments/momo/callback/{collection,disbursement}` (MTN; never trusted — status is re-checked with MTN) |

Who may call what: see [PERMISSIONS.md](PERMISSIONS.md).
