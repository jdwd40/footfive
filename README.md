# FootFive / Proball Manager

Shared 24/7 cyborg Proball. Claim a team, manage the squad between rounds, coach live, bet with personal credits.

**Phase 12 (live):** admin login → `/admin` (with password-change gate); Admin nav; official team abbreviations on tickers.  
**Phase 11:** **15s per match minute**; slower live events; admin account bootstrap.

**CI/CD:** push to `main` → GitHub Actions (`deploy.yml`) builds `/footfive/` and deploys SPA + PB hooks/migrations to the VPS. See `deploy/DEPLOY.md`.

## Money

| Wallet | Field | Use |
|---|---|---|
| Team treasury | `proball_teams.treasury` | Upgrades, batteries, repairs |
| Betting credits | `users.credits` | Bets only (start **1000**) |

Teams start with treasury **2500**. UK-style grouping in UI (`en-GB`).

## Quick start

```bash
npm install && npm run setup:local
cd pocketbase && ./pocketbase superuser upsert admin@example.com 'pass' && cd ..
npm run pb:serve   # :8090
npm run dev        # :5173
```

`VITE_POCKETBASE_URL=http://127.0.0.1:8090`

Do **not** wipe `pb_data` for additive migrations. PocketBase **0.28.4** only — do not upgrade.

## Records

- UI: `/records` — overview, teams, players, tournaments, match archive, my bets.
- APIs: `GET /api/footfive/records/{overview,teams,players,tournaments,matches}`, `GET /api/footfive/bets/history`.
- Permanent summaries: `match_summaries`, `tournament_summaries`.
- Settlement once per fixture via `match_states.progression_settled` + unique summary `fixture_id`.

## Administration

- UI: `/admin` (requires `users.role = admin`).
- All actions server-checked; normal users get 403.
- Sensitive actions write `admin_audit_logs`.
- Credits/treasury: transactional ledger, reason required, no negatives.
- **Between-round break** (default **1 minute**), championship gap (10) and fixture window (5): Admin → Dashboard. See `docs/OVERHAUL.md`.
- Login: email **or** username via `/api/footfive/auth/login`.

```text
GET/POST  /api/footfive/admin/users
POST      /api/footfive/admin/users/{id}/disable|enable
DELETE    /api/footfive/admin/users/{id}
POST      /api/footfive/admin/users/{id}/credits
POST      /api/footfive/admin/teams/{id}/treasury|assign|release|reset
GET/POST  /api/footfive/admin/world/*  (catch-up, pause, resume, settings, apply-between-round)
GET/POST  /api/footfive/admin/retention[ /preview|/run ]
GET       /api/footfive/admin/audit
POST      /api/footfive/auth/login   (identity = email or username)
```

Trusted server promote:

```bash
export FOOTFIVE_PB_URL=http://127.0.0.1:8091
export FOOTFIVE_SUPERUSER_EMAIL=...
export FOOTFIVE_SUPERUSER_PASSWORD=...
export FOOTFIVE_ADMIN_EMAIL=...   # operator admin email (required for --username admin)
export FOOTFIVE_ADMIN_PASSWORD=...   # never commit
node scripts/footfive-admin.mjs ensure-admin --username admin --confirm
```

## Retention

| Setting | Meaning |
|---|---|
| 7 / 30 / 90 | Days after tournament **completion** before purging detailed timelines |
| 0 (Never) | Automatic cleanup disabled |

- Eligible: completed fixture + complete tournament + compact summary exists + older than cutoff.
- Deletes: heavy `events_json`, old coaching commands, expired tactical scans.
- Keeps: scores, shootout scores, champions, team/player records, ledgers, bets settlement, audit.
- Cron: `footfive_retention_daily` at `0 3 * * *`.
- Admin preview never deletes; manual run requires confirmation in UI.

## Backup & restore (PB 0.28.4)

**Backup (dev/prod):**

1. Stop PocketBase (`Ctrl+C` / service stop).
2. Copy directory `pocketbase/pb_data/` to a safe path (includes `data.db`, WAL, storage).
3. Optionally copy `pocketbase/pb_migrations/` and `pocketbase/pb_hooks/` (code is in git).
4. Restart PocketBase.
5. **Never commit** `pb_data` to Git.

**Restore:**

1. Stop PocketBase.
2. Replace `pocketbase/pb_data/` with the backup copy.
3. Start PocketBase with the **same** 0.28.4 binary.
4. Migrations already applied in backup will not re-run; code hooks load from disk.

Retention never deletes backups.

## Shootout kicks

Match view includes `shootoutKicks[]`:

- `kickIndex`, `team`, `kickNumber`, `suddenDeath`, `outcome` (goal/save/miss)
- `mustScore`, `decisive`, `takenHome` / `takenAway`

Frontend board renders markers from this list — not from score alone.

## Key management routes

- `GET /api/footfive/my-team` · lineup · intensity · finances
- `POST /api/footfive/players/{id}/upgrade|battery|repair`
- `GET/POST /api/footfive/command-charge`

## Live watching

- Scoreboard poll ~3s; match poll ~2s.
- Events reveal one-by-one; **Catch up to Live** flushes queue.
- Visible score follows revealed goals only.

## Tests

```bash
npm run test              # unit (vitest)
npm run typecheck
npm run build
npm run test:e2e:api      # API e2e (needs pb:serve)
npm run pw:libs           # vendor chromium libs (no root)
npx playwright install chromium
npm run test:e2e          # isolated pb_data_test + API + Playwright UI
npm run test:recovery
npm run rehearsal         # isolated production-style rehearsal
npm run backup:local
npm run perf:sample
```

CI: `.github/workflows/footfive-ci.yml` (Playwright official container).

## Health

- `GET /api/footfive/health` — safe public status  
- `GET /api/footfive/admin/health` — admin operational detail  
- Admin UI dashboard shows system health  

## Temporary password

Admin reset with “must change” → user must complete `/change-password` before other app routes.

## Account security (server-enforced)

- `role`, `disabled`, `must_change_password`, `credits` and `admin_note` are server-owned.
  Any create/update on the native users collection that contains one of these fields is
  **rejected** (403, "Field … is server-owned") for every application user, admins included —
  even when the value is unchanged. The only exception is the trusted PocketBase superuser
  (server-ops CLI). Application-admin changes go through the protected, audited
  `/api/footfive/admin/*` routes. Ordinary signup and profile edits (ordinary fields only)
  are unaffected.
- `must_change_password` is enforced on every protected `/api/footfive/*` route and on native
  collection access (403 "Password change required"; native business list rules return no rows).
  The only reachable exceptions are session discovery (`GET /api/footfive/me`) and
  `POST /api/footfive/account/change-password`, plus login/auth-refresh — no business data
  while the flag is set. Native users list/view stay self-only (`id = @request.auth.id`) so a
  forced-password user can still read its own record for session discovery, but they
  additionally require `disabled = false`. Native forced self-writes (profile or password)
  reject — 403 from the hooks, or 404 when the hardened users update rule hides the record.
  The flag is cleared only by the change-password route.
- Disabling an account rotates its `tokenKey`, so existing tokens stop working immediately and
  stay invalid after re-enable. Accounts already disabled before this enforcement was deployed
  have their tokens revoked by migration `1750000016_account_security_rules.js` at upgrade —
  EVERY disabled record is rotated (fully paginated, no capped page) — no data reset; records,
  IDs and business data are preserved. Disabled rejection is scoped by route class:
  - **Public routes** — `/api/footfive/health`, `/api/footfive/public-scoreboard` and
    `/api/footfive/auth/login` deliberately skip account-state checks entirely: no
    pre-existing auth token is required or consulted. `/health` and `/public-scoreboard`
    answer 200 without a token, and also 200 with a still-valid token of a disabled
    record. `POST /auth/login` instead validates the submitted credentials and answers
    401 "Invalid credentials" (generic, no account-state disclosure) for a nonexistent
    identity, a wrong password and a disabled account alike, or 400 when identity or
    password is missing; only valid credentials for an enabled account get 200.
  - **Protected routes** — every other `/api/footfive/*` route, including the session-discovery
    (`/me`) and change-password exceptions (those exempt only forced-password users, never
    disabled ones): a revoked token fails auth with 401, and any still-valid token presented
    for a disabled record gets 403 "Account disabled". Native users self-read (list/view) is
    likewise closed to disabled accounts by the `disabled = false` rule above.
  (401 = token invalid/revoked; 403 = authenticated but forbidden by account state.)
- Login errors are generic and do not reveal account state, but the two login surfaces differ:
  the custom `/api/footfive/auth/login` route answers 401 "Invalid credentials" for a
  nonexistent identity, a wrong password and a disabled account alike; PocketBase's native
  `auth-with-password` endpoint answers 400 "Failed to authenticate." for the same cases.
  PocketBase's native rate limiter is enabled (`pb_migrations/1750000015_rate_limits.js`):
  120 requests/min per IP on the password-login surfaces above and on the `*:auth` endpoint
  class (429 beyond that, verified on both login surfaces; headroom for NAT/shared IPs,
  bcrypt cost bounds per-IP throughput), plus a general 300 requests/10s per-IP `/api/` budget.
  The real client IP comes from nginx's `X-Real-IP` via PocketBase's trusted-proxy setting
  (`pb_migrations/1750000018_trusted_proxy.js`; see `deploy/DEPLOY.md`). On a 429 the client
  backs off (honouring `Retry-After`), does not count it towards Reconnecting/Offline, and
  keeps showing the last good data.
  A 429 is throttling, not an auth failure: the frontend preserves a healthy session on 429
  (on `/me` and on auth-refresh alike) and clears it only on definitive rejections —
  auth-refresh 400, `/me` 401, or disabled 403.

## Deploy / production

**Live:** https://jdwd40.com/footfive/  
**API:** https://jdwd40.com/footfive-pb/  

VPS layout (confirmed Prompt 8):

| Path | Use |
|---|---|
| `/home/jd/footfive/` | App root (`pb_data`, hooks, releases) |
| `/var/www/jdwd40.com/html/footfive/` | Static SPA |
| `footfive-pocketbase.service` | systemd |
| `/var/backups/footfive/` | Timestamped backups (root, 700) |

See `deploy/DEPLOY.md` and `prompt outputs/prompt8_output.md`.

## PocketBase 0.28.4

Pinned. Migrations in `pb_migrations/`, hooks in `pb_hooks/`.

Cron:

- `footfive_catchup` every minute
- `footfive_retention_daily` at 03:00
