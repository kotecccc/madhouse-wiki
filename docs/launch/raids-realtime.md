# Raid schedule realtime sync

Updated: 2026-10-21.

## Data flow

One long-lived MTProto worker listens to new, edited, and deleted posts from
`@raidsMadness`. It writes parsed schedules to the private Vercel Blob. At
startup and every ten minutes it scans up to 500 recent messages to recover
changes missed during a disconnect. A renewable Blob lease prevents a second
worker or the recovery endpoint from using the same Telegram session. The
worker renews the lease every 30 seconds; the lease expires after two minutes.

The public `/api/raids` endpoint is uncached. While the Wiki page is open, it
refreshes the feed every ten seconds. Telegram updates are event-driven; the
history scan is a recovery mechanism.

The display maps source markers as ✅ = completed (red), ▶️/▶ = active (green),
and no marker = scheduled (gray). This is inferred from observed posts; the
channel has not published a definitive status glossary.

## Run the worker

Run exactly one worker instance and connect it to the same private Blob as the
Wiki Production project. This deployment uses a LaunchAgent on the Mac. Its
ignored `.env.local` supplies these environment variables:

- `BLOB_READ_WRITE_TOKEN`
- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `TELEGRAM_RAIDS_SESSION_ENCRYPTION_KEY`

The encrypted MTProto session is read from the private Blob. Keep the
decryption key and Blob token in the host's secret store. Never place the
decrypted session in environment variables, image layers, logs, or a checked-in
file. Do not run more than one worker instance: Telegram may revoke the session
if it is active from multiple IP addresses.

For a local worker, use the ignored `.env.local` and run
`npm run start:raids-worker`. Keep the process under a supervisor that restarts
it after failures. A local Mac pauses the listener during sleep, shutdown, or
logout; the next startup scan recovers missed channel changes.

`Dockerfile.raid-worker` is an optional container setup for a future host. If it
is used, inject the same variables from that host's secret store and stop the
Mac LaunchAgent first so only one worker uses the Telegram session.

## Recovery endpoint

`GET /api/telegram/raids-sync` remains protected by
`Authorization: Bearer $CRON_SECRET` for an operator-triggered history
reconciliation. New Wiki builds do not schedule a Vercel Cron job. Vercel
Functions have a finite maximum duration and cannot replace the long-lived
MTProto listener.
