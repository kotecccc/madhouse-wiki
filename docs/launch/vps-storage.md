# Madhouse private storage on the existing VPS

The Wiki frontend and serverless APIs remain on Vercel. Private data lives in
`/opt/madhouse-storage/data` on the existing Frontend Punks VPS: the projected
reference SQLite, raid schedules, encrypted Telegram session, synchronization
lease, encrypted connector account sessions, and consented analytics events.
Frontend Punks data and containers are separate.

The `madhouse-storage` container uses `scripts/storage/compose.yml`, is limited
to 128 MiB / 0.5 CPU, and listens only on `127.0.0.1:9091`. The existing HTTPS
nginx host forwards `/_madhouse-storage/` using `scripts/storage/nginx.conf`.
All object requests require a dedicated bearer token; request bodies, tokens,
and session values must never appear in logs or source control.

Both Vercel projects and the VPS raid worker use:

- `MADHOUSE_STORAGE_ORIGIN=https://storage.madhouse-wiki.ru/_madhouse-storage`
- `MADHOUSE_STORAGE_TOKEN` from the secret store

The server loads the matching token from `/opt/madhouse-storage/.env`.
Do not expose port 9091 publicly. The service only accepts allowlisted paths,
bounded bodies, and conditional writes. Account-session names are HMACs and
values remain AES-GCM encrypted. Only analytics events support listing and
deletion; account-session directories cannot be listed through the API.
Atomic file replacement and
ETags preserve the existing optimistic concurrency and exclusive lease behavior.
The Telegram encryption key remains separate from the encrypted session.

Both storage variables are mandatory. There is no Blob fallback or Blob SDK
dependency. Missing configuration fails closed. The old Blob stores remain
untouched because suspended stores currently cannot be exported. Historical
analytics and previous account sessions have not been imported; users
establish new sessions on their next login.

Initial recovery uses the strict `packageSeed` projection from the canonical
local catalogue and the saved production raid API response (30 posts, latest
raid date 2026-10-22). Live synchronization replaces the saved schedules using
the existing version-aware importer after Telegram authentication.

Verify service health with an authorized object GET and confirm that an
unauthenticated GET is rejected. Verify `/api/catalogue` and `/api/raids?limit=1`
on the public Wiki after every deployment, separately from static assets.
The raid worker is bundled locally with `npm run build:raids-worker`, avoiding
dependency installation on the production VPS. Deploy `.vercel/raid-worker/`
to `/opt/madhouse-raid-worker/app/` and use `scripts/storage/worker-compose.yml`.
Its protected `.env` contains only Telegram application credentials, the
session encryption key, and storage configuration. The container has a
256 MiB memory cap and no published ports. The Mac LaunchAgent is disabled;
never start both workers. Before initial startup, establish the encrypted
Telegram session with `scripts/telegram/setup-raids-session.mjs`. If it is
missing, the worker must not claim synchronization is live.

Backups live under `/opt/madhouse-storage/backups`; `scripts/storage/backup.sh`
runs daily with seven rotating slots. Keys and environment files are excluded.
Keep a separate protected
off-host copy before any destructive maintenance. Never replace or delete the
session or lease while a live worker holds the lease.
