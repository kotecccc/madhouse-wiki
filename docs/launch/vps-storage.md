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
never start both workers. The VPS worker was authenticated and started on
2026-10-23; its initial reconciliation completed with `raids_worker_ready`.
Before a future initial startup, establish the encrypted
Telegram session with `scripts/telegram/setup-raids-session.mjs`. If it is
missing, the worker must not claim synchronization is live.

The prepared storage server additionally accepts only the HMAC-named
`game-credentials/<64-hex>.json` namespace for encrypted Wiki game credentials,
with the same 32 KiB limit and conditional-write rules as account sessions.
It is deployed separately from Wiki images. Confirm the installed storage server
supports this namespace before enabling Bridge or migrating Wiki authentication;
the source change alone does not establish the installed host state.

On 2026-10-27 a read-only comparison found that the installed server lacked
this namespace. Its SHA-256 was
`21c4b532e11e362183732a301417fdd7154fdbd00d345081345d747052e31fac`,
matching `scripts/storage/server.mjs` at Wiki commit `055cb2e`. Its source
differed from the prepared server only in the new path allowlist and its 32 KiB
limit. An isolated exercise with synthetic data
switched old → new → old → new against the same temporary storage directory:
an existing account object and its ETag survived, stale conditional writes were
rejected, and a new credential became accessible again after the new server
was restored. The old server returned 404 for the new credential. Therefore,
after Wiki begins using this namespace, rolling back only storage to the old
server will break credential access. This local exercise does not validate
the installed service's actual data, deployment procedure, or a coordinated
production rollback. Recheck the installed source and state before migration.

Backups live under `/opt/madhouse-storage/backups`; `scripts/storage/backup.sh`
runs daily with seven rotating slots. Keys and environment files are excluded.
Keep a separate protected
off-host copy before any destructive maintenance. Never replace or delete the
session or lease while a live worker holds the lease.

The checked-in legacy `backup.sh` writes an unencrypted compressed archive; it
does not satisfy the Bridge encrypted-backup gate. A separate prepared
`backup-encrypted.sh` pipes an offline, quiescent `data` copy through `age` and
requires an explicit operator confirmation and recipient. It has not been
installed or scheduled on the host. The confirmation is an operator assertion,
not a service-stop or snapshot-consistency check. Test restore, encryption keys,
retention, off-host custody and coordination with the independent automation
database before adopting it; do not stop or alter production for a local test.
