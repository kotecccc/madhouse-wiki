# Telegram raid schedule feed

The raid feed is separate from the SQLite game catalogue. A long-lived MTProto
worker listens to new, edited, and deleted channel posts from `@raidsMadness`,
parses schedule posts, and writes them to a private Vercel Blob. It reconciles
recent channel history at startup and every ten minutes to recover updates
missed while disconnected. The public `/api/raids` endpoint returns parsed
schedule fields and links to the source posts.

The parser accepts posts titled `РЕЙДЫ — DD.MM.YYYY` when their rich-message table or tab/pipe-separated text has the columns `Зона`, `Время`, `Клан`, `Босс`, `Ведущий`, and `Длит.`. It retains the source wording, zone markers, duration values, and the post's `Время: ...` value, while normalizing cell whitespace for display. It does not map names to catalogue entities or OCR images.

The UI displays ✅ as completed, ▶️/▶ as active, and no marker as scheduled.
These meanings are inferred from observed posts; the channel has no published
marker legend. Each status preserves its source marker and provides an accessible
explanation. Unsupported pictographic markers remain in the zone field and receive
an unknown status.

## Telegram session and worker

The Telegram user session has already been encrypted and saved in the private
Wiki Blob. The worker also needs `BLOB_READ_WRITE_TOKEN`, `TELEGRAM_API_ID`,
`TELEGRAM_API_HASH`, and `TELEGRAM_RAIDS_SESSION_ENCRYPTION_KEY` in its
environment. Run one replica from `Dockerfile.raid-worker`; do not put the
decrypted session string in environment variables, image layers, logs, or a
checked-in file. For a local worker, use the ignored `.env.local` and run
`npm run start:raids-worker`; see [the realtime runbook](../launch/raids-realtime.md)
for long-lived host and recovery guidance.

An MTProto session grants full access to the Telegram account that authorized it. The worker uses it only to read the fixed `@raidsMadness` channel. The encrypted blob is private, the encryption key stays in environment variables, and the browser receives neither the session nor the key. Do not run the provisioning script in a shared terminal or paste Telegram QR codes, login codes, or session strings into chat.

To rotate the stored session, run the setup script with `--replace`, then revoke the previous `Madhouse Wiki raid importer` device in Telegram Settings → Devices. If provisioning fails before saving, the script attempts to log out and revoke the new session.

## Sync behavior

- The worker scans up to 500 recent channel history entries at startup and every ten minutes, batch-upserts parsed schedules by Telegram message ID, and updates changed source posts.
- It removes a schedule from the feed when a fetched source message is edited so it no longer matches, or when a source post disappears from the scanned history window.
- New, edited, and deleted posts are applied as they arrive through the MTProto update stream. A renewable private Blob lease prevents a second worker or recovery sync from using the session at the same time.
- `/api/raids` returns up to 30 parsed schedules without CDN caching. The browser refreshes the public feed every 10 seconds while the Wiki is open.
- Schedule values remain source data. They are not added to `local-data/madhouse.sqlite` and are not treated as verified game catalogue definitions.

## Endpoints

- `GET /api/raids` returns the most recent parsed schedule posts and public Telegram links.
- `GET /api/telegram/raids-sync` is a protected recovery endpoint and requires `Authorization: Bearer $CRON_SECRET`. New Vercel builds do not schedule it as a Cron job; the existing Production deployment retains its old daily schedule until a replacement is released.

If no session or private Blob is configured, the sync returns a generic unavailable response; it does not expose Telegram errors or credentials.

## Local schedule fixture

For UI development, a public Production `/api/raids` response is saved separately
from the catalogue in the ignored `artifacts/development/raids-production.json`.
The adjacent `raids-production-source.json` records its source and capture time.
Run `npm run dev:raids` to serve this fixed response from the Vite development
server. If port 4174 is occupied, use `npm run dev:raids -- --port 4176`.

This opt-in middleware is development-only; it does not bundle fixtures or change
Production API behavior. Without the opt-in, normal development routing is retained.
To refresh the fixture, save a new public response and update its provenance file.

## Optional feed pagination

`GET /api/raids` retains the legacy `{ posts }` response (up to 30 schedules).
The Wiki requests `GET /api/raids?limit=1` for its current schedule. Paginated
responses contain `{ posts, nextCursor }`; `limit` accepts 1–10 and the next page
uses `before=<nextCursor>`. The cursor is based on source date and message ID so
removing a boundary post does not break pagination. Paginated reads expose at
most the 180 schedules retained by the existing store. The Blob still holds one
bounded JSON envelope; pagination limits the response sent to the browser, not
internal Blob reads.

Archive requests begin only when its disclosure is opened. The client requests
three schedules per page and loads more when the end approaches the viewport;
a “Загрузить ещё” button also supports keyboard/manual use. Closing the archive
unmounts its content and aborts pending fetches. Reopening starts from its first
page. The development fixture uses the same query validation and paging helper.
