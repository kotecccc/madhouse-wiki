# Madhouse private storage on the existing VPS

The Wiki frontend and serverless APIs remain on Vercel. Four private objects
now live in `/opt/madhouse-storage/data` on the existing Frontend Punks VPS:
the projected reference SQLite, raid schedules, encrypted Telegram session,
and the synchronization lease. Frontend Punks data and containers are separate.

The `madhouse-storage` container uses `scripts/storage/compose.yml`, is limited
to 128 MiB / 0.5 CPU, and listens only on `127.0.0.1:9091`. The existing HTTPS
nginx host forwards `/_madhouse-storage/` using `scripts/storage/nginx.conf`.
All object requests require a dedicated bearer token; request bodies, tokens,
and session values must never appear in logs or source control.

Vercel Production and the existing Mac raid LaunchAgent use:

- `MADHOUSE_STORAGE_ORIGIN=https://tikhon-mentor.ru/_madhouse-storage`
- `MADHOUSE_STORAGE_TOKEN` from the secret store

The server loads the matching token from `/opt/madhouse-storage/.env`.
Do not expose port 9091 publicly. The service only accepts four allowlisted
paths, bounded bodies, and conditional writes. Atomic file replacement and
ETags preserve the existing optimistic concurrency and exclusive lease behavior.
The Telegram encryption key remains separate from the encrypted session.

If both storage variables are absent, source code retains the original Blob
transport for compatibility. Production must keep both variables configured;
the previous Blob store is suspended and cannot serve as a working fallback.

Initial recovery uses the strict `packageSeed` projection from the canonical
local catalogue and the saved production raid API response (30 posts, latest
raid date 2026-10-22). Live synchronization replaces the saved schedules using
the existing version-aware importer after Telegram authentication.

Verify service health with an authorized object GET and confirm that an
unauthenticated GET is rejected. Verify `/api/catalogue` and `/api/raids?limit=1`
on the public Wiki after every deployment, separately from static assets.
The raid worker remains the existing Mac LaunchAgent; storage migration alone
does not move the long-lived Telegram process to the VPS.

Backups live under `/opt/madhouse-storage/backups`; keep a separate protected
off-host copy before any destructive maintenance. Never replace or delete the
session or lease while a live worker holds the lease.
