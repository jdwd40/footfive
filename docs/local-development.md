# Isolated local development and testing

## Choose the current repository

Use [jdwd40/footfive](https://github.com/jdwd40/footfive): one repository contains
React 19 + TypeScript + Vite (`src/`) and PocketBase JavaScript hooks and migrations
(`pocketbase/pb_hooks`, `pocketbase/pb_migrations`). PocketBase owns SQLite storage,
authentication, APIs and simulation jobs; no separate Node/Express/PostgreSQL
backend is needed.

The READMEs for [footfive-front](https://github.com/jdwd40/footfive-front) and
[footfive_front](https://github.com/jdwd40/footfive_front) mark them inactive/legacy.
[footfive_back](https://github.com/jdwd40/footfive_back) describes the historical
Express/Postgres architecture. Do not set up those repositories for current work.
Read `AGENTS.md`, `README.md` and `deploy/DEPLOY.md` before changing the app.

## Install and run

Use **Node 22** (matches CI), npm, Python 3, curl and unzip on Linux amd64/arm64.
Use a dedicated checkout. Never bring in a production `.env`, database, backup,
credential or service configuration.

```bash
git clone https://github.com/jdwd40/footfive.git footfive-dev
cd footfive-dev
npm ci
npm run setup:local
```

`setup:local` downloads PocketBase **0.28.4**, verifies its pinned SHA-256, and
creates `.env` from `.env.example`. Keep `VITE_POCKETBASE_URL=http://127.0.0.1:8090`.
Do not upgrade PocketBase. Confirm ports 8090 and 5173 are free before starting.

In separate terminals from the repository root:

```bash
npm run pb:serve
```

```bash
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Open http://127.0.0.1:5173/. Register a new local account to manage a team.
Migrations and the app health request bootstrap a synthetic world from code.
The backend listens only on loopback. Stop each foreground process with Ctrl+C;
restart with the same commands. Development data persists across restarts.

```bash
curl -fsS http://127.0.0.1:8090/api/health
curl -fsS http://127.0.0.1:8090/api/footfive/health
```

App health must report `status: ok` and `worldAvailable: true`.
For local administration follow `scripts/footfive-admin.mjs` and README trusted
operator instructions using newly generated local credentials only. PocketBase
superusers and app administrators are separate identities. Keep credentials in
private ignored files, never in Git, command history, logs or messages.

## Data and port separation

| Purpose | Database directory | API | Web |
|---|---|---|---|
| Persistent development | `pocketbase/pb_data/` | 8090 | 5173 |
| Disposable API/UI tests | `pocketbase/pb_data_test/` | 8091 | 5174 (override below) |
| Optional rehearsal | `pocketbase/pb_data_rehearsal/` | 8092 | 4173 |

All paths above are inside this checkout and ignored by Git. Never wipe
`pb_data` to apply migrations. Back it up with `npm run backup:local` if needed.
Test data is synthetic and recreated by the test runner; never store manual work
in `pb_data_test`. The test seed contains deliberately public test credentials;
keep that backend on loopback and do not use those accounts in dev or production.

## Verification

Run checks from the root with Node 22 selected:

```bash
npm test -- --maxWorkers=4
npm run typecheck
npm run lint
npm run build
npx playwright install chromium
E2E_WEB_PORT=5174 npm run test:e2e
```

The web-port override avoids the running Vite dev server. The runner builds a
preview targeting **8091**, seeds disposable accounts, runs API + mobile/desktop
Chromium tests and security/recovery checks, then stops its own processes on exit.
`dist/` will contain the test API URL afterwards; rebuild with the desired local
URL before manually using `npm run preview`. The running Vite dev server reads
`.env` and is unaffected. Browser traces/reports live in `test-results/` and
`playwright-report/`; backend and preview logs are `e2e-pb.log` and `e2e-web.log`.

For API-only verification:

```bash
npm run test:integration
```

Run test commands serially: the runners share `pb_data_test` and fixed log paths.
Before full e2e, ensure 8091, 5174 and its internal regression ports 8293, 8294,
8297 are unused. The full runner deletes `pb_data_test` and does not guard all
port collisions. Do not run it against an existing manual test instance. Optional
`E2E_ALL=1` adds the other configured viewport projects. Optional Firefox requires
its browser download. On systems missing shared browser libraries, try `npm run
pw:libs`; its Ubuntu package fallback is not portable to every Linux distribution.

`npm run test:recovery` targets a running backend and creates records; explicitly
set `PB_URL` to an isolated local backend. It exercises the recovery API, not an
actual process restart. `npm run rehearsal` also clears its scratch database and
uses `fuser -k` on its selected backend port: inspect it and reserve its ports
before running; never run against another service's port.

## OpenBot workstation instance

Provisioned 2026-11-02 at `/home/jd/OpenBot/Shared/footfive-dev`, based on commit
`0f3f648bfaf07a8961da4639d26dddf4486ea6da`, branch `dev/local-test-environment`.
Persistent dev runs as transient user services `footfive-dev-pb.service` and
`footfive-dev-web.service`. They survive this terminal/chat and stop with the user
session or reboot; they are not enabled boot services.

```bash
systemctl --user status footfive-dev-pb footfive-dev-web
journalctl --user -u footfive-dev-pb -u footfive-dev-web -n 50
systemctl --user stop footfive-dev-web footfive-dev-pb
```

After stopping, restart using the foreground commands above, or recreate the
transient services (these exact paths are specific to this workstation):

```bash
systemd-run --user --unit=footfive-dev-pb --collect \
  --property=WorkingDirectory=/home/jd/OpenBot/Shared/footfive-dev/pocketbase \
  /home/jd/OpenBot/Shared/footfive-dev/pocketbase/pocketbase serve --http=127.0.0.1:8090
systemd-run --user --unit=footfive-dev-web --collect \
  --property=WorkingDirectory=/home/jd/OpenBot/Shared/footfive-dev \
  --setenv=VITE_POCKETBASE_URL=http://127.0.0.1:8090 \
  /home/jd/.local/share/mise/installs/node/22.23.4/bin/node \
  /home/jd/OpenBot/Shared/footfive-dev/node_modules/vite/bin/vite.js \
  --host 127.0.0.1 --port 5173 --strictPort
```

Fresh dev administrator and manager accounts were provisioned and authenticated;
credentials are in `.footfive-credentials.local` (mode 600, ignored). Read that
file locally when signing in; do not attach it to reports. It also contains the
separate local PocketBase superuser credentials. Do not rerun test seeding against
this persistent dev database. Verification logs are in ignored `logs/`.
