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
- **Between-round minutes** (default **3**): save on admin dashboard; optional apply to waiting round only.
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
