# Telegram raid schedule feed

The raid feed is separate from the SQLite game catalogue. A daily Vercel Cron invocation uses an encrypted user MTProto session to read recent history from `@raidsMadness`, parses schedule posts, and stores the result in a private Vercel Blob. The public `/api/raids` endpoint returns parsed schedule fields and links to the source posts.

The parser accepts posts titled `РЕЙДЫ — DD.MM.YYYY` when their rich-message table or tab/pipe-separated text has the columns `Зона`, `Время`, `Клан`, `Босс`, `Ведущий`, and `Длит.`. It retains the source wording, zone markers, duration values, and the post's `Время: ...` value, while normalizing cell whitespace for display. It does not map names to catalogue entities, infer meaning from symbols, or OCR images.

## Configure and provision the Telegram session

1. Connect a new private Vercel Blob store to the **Wiki** project. The existing connector Blob is a separate store and must not be reused for this account session. New Vercel Blob connections use OIDC by default and add `BLOB_STORE_ID`; a long-lived `BLOB_READ_WRITE_TOKEN` is not needed for code running in the connected Vercel project. Keep the connection Production-only except during the local session setup below.
2. Add these values to the Wiki Vercel project for Production:
   - `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from the Telegram application used by the Wiki connector.
   - `TELEGRAM_RAIDS_SESSION_ENCRYPTION_KEY`, a 32-byte hex key. Generate one with `openssl rand -hex 32`; use the same value locally and in Vercel.
   - `CRON_SECRET`, a random string of at least 16 characters. Generate one with `openssl rand -hex 32`.
3. For local setup, temporarily enable both Production and Development in the Wiki project's Blob connection. Link the checkout to that project and pull Development settings to a temporary ignored file with `umask 077 && npx vercel@latest env pull .env.raid.local --environment=development --yes`. Put the actual `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, and `TELEGRAM_RAIDS_SESSION_ENCRYPTION_KEY` values in `.env.local`, along with `BLOB_STORE_ID` and the short-lived Development `VERCEL_OIDC_TOKEN` from `.env.raid.local`. Do not copy `[SENSITIVE]` placeholders. Protect `.env.local` with mode `0600`, and delete the temporary pull file after merging. The OIDC token expires and can be refreshed with another `env pull`; do not create a long-lived Blob token for this setup.
4. Run `node --env-file=.env.local scripts/telegram/setup-raids-session.mjs` in a private terminal. It displays a Telegram login QR. Scan it in the Telegram account that can read `@raidsMadness` and approve the new session in the official Telegram app. If two-step verification is enabled, the script asks for its password through a hidden terminal prompt. The script verifies access to the channel history, exports the MTProto session, encrypts it with AES-GCM, and saves it to the private Wiki Blob. It never prints or saves the session string in the repository. After the encrypted session is saved, remove Development from the Blob connection and delete the local `BLOB_STORE_ID` and `VERCEL_OIDC_TOKEN` values.
5. Deploy the Wiki project. The public channel page showed schedule post [73](https://t.me/raidsMadness/73) at 19:12 UTC (22:12 Minsk) on 20 October 2026. The Wiki Cron runs at 20:00 UTC (23:00 Minsk), after that observed publication and before the next calendar day. Vercel Hobby has per-hour scheduling precision, so the daily invocation may arrive up to 59 minutes after its scheduled time ([Vercel Cron usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing)). This is based on one observed post; review the schedule if the channel's publishing time changes.

An MTProto session grants full access to the Telegram account that authorized it. The importer uses it only to read the fixed `@raidsMadness` channel. The encrypted blob is private, the encryption key stays in environment variables, and the browser receives neither the session nor the key. Do not run the provisioning script in a shared terminal or paste Telegram QR codes, login codes, or session strings into chat.

To rotate the stored session, run the setup script with `--replace`, then revoke the previous `Madhouse Wiki raid importer` device in Telegram Settings → Devices. If provisioning fails before saving, the script attempts to log out and revoke the new session.

## Sync behavior

- The importer scans up to 500 recent channel history entries each day, batch-upserts parsed schedules by Telegram message ID, and updates changed source posts.
- It removes a schedule from the feed when a fetched source message is edited so it no longer matches, or when a source post disappears from the scanned history window.
- The sync uses an expiring private Blob lock so concurrent invocations do not use the same MTProto session at once.
- `/api/raids` returns up to 30 parsed schedules. The browser refreshes the public feed every five minutes while the Wiki is open.
- Schedule values remain source data. They are not added to `local-data/madhouse.sqlite` and are not treated as verified game catalogue definitions.

## Endpoints

- `GET /api/raids` returns the most recent parsed schedule posts and public Telegram links.
- `GET /api/telegram/raids-sync` is reserved for Vercel Cron and requires `Authorization: Bearer $CRON_SECRET`.

If no session or private Blob is configured, the sync returns a generic unavailable response; it does not expose Telegram errors or credentials.
