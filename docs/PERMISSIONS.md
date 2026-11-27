# Roles and permissions

Two kinds of role:

- **Platform role** (one per account): `USER` or `SUPER_ADMIN`.
- **Group role** (one per group membership): `MEMBER`, `TREASURER` or `GROUP_ADMIN`. Leaders = admin + treasurer.

The API enforces every rule below; the web app only hides what a role cannot use.

| Action | Member | Treasurer | Group admin | Super admin |
|---|:-:|:-:|:-:|:-:|
| See own statement, loans, fines, receipts | ✅ | ✅ | ✅ | read |
| Group summary (cash, savings, share-out preview) | ✅ | ✅ | ✅ | read |
| Ledger, contribution matrix, arrears, loan portfolio, cash book | — | ✅ | ✅ | read |
| Pay contributions / repay loans (MoMo or proof) | ✅ | ✅ | ✅ | — |
| Confirm or reject a manual payment (never their own) | — | ✅ | ✅ | — |
| Apply for a loan | ✅ | ✅ | ✅ | — |
| Approve or reject a loan (never their own; group sets how many approvals) | — | ✅ | ✅ | — |
| Write off / extend a loan, call guarantees | — | ✅ | ✅ | — |
| Issue or waive a fine (never to themselves) | — | ✅ | ✅ | — |
| Record an expense / approve another leader's expense | — | ✅ | ✅ | — |
| Social fund payouts (request any member; approve: another leader) | request own | ✅ | ✅ | — |
| Edit contribution, loan, social-fund and governance rules | — | — | ✅ | — |
| Invite, approve join requests, suspend or remove members | — | — | ✅ | ✅ |
| Change roles, replace treasurer, transfer admin (group keeps ≥ 1 admin) | — | — | ✅ | ✅ |
| Prepare cycle close & share-out | — | ✅ | ✅ | — |
| Approve share-out | — | — | ✅ | — |
| Schedule meetings, take attendance, publish minutes and constitution | — | ✅ | ✅ | — |
| Polls: vote / open | vote | vote, open | vote, open | — |
| Announcements | read | read | write | — |
| Group audit log | — | ✅ | ✅ | all groups |
| Ask to leave the group / settle someone's exit | ask | ask, settle | ask, settle | — |
| Verify / reject / restore groups, group payment accounts | — | — | — | ✅ |
| Users: search, suspend, unlock, reset access, read-only support view | — | — | — | ✅ |
| Platform settings, fees, SMS log, job queue, deletion requests | — | — | — | ✅ |

Extra rules

- **Money moves only in verified groups** (a super admin verifies them).
- **Two-step for leaders**: when the platform switch `requireLeaderTwoFactor` is on, admins and treasurers
  without two-step verification get `403` on every money-moving group route (reads still work).
- **Super admins read, they do not act inside groups**: group reads are allowed; group writes need a
  membership (except member management listed above).
- **Support view** (`impersonate`) is read-only: any non-GET request is refused and audited.
- Every change is written to the audit log with who, what, before/after and IP.
