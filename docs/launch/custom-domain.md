# Custom domain cutover

The custom-domain cutover completed on 2026-10-23. All three public HTTPS
origins are active:

- Wiki: `https://madhouse-wiki.ru` (apex domain, existing Wiki Vercel project).
- Telegram connector: `https://connect.madhouse-wiki.ru` (existing isolated
  connector Vercel project).
- Private storage: `https://storage.madhouse-wiki.ru/_madhouse-storage`
  (existing VPS storage service behind nginx).

The Wiki and connector Vercel Production variables now use the new canonical
origins. The Telegram bot menu and webhook are configured to use the Wiki apex
domain. BotFather's separate Login Widget domain has not been changed; the
current application does not use that widget.

## DNS records

The Selectel zone contains these records:

| Name      | Type  | Target                                        |
| --------- | ----- | --------------------------------------------- |
| `@`       | A     | `216.198.79.1`                                |
| `@`       | A     | `64.29.17.1`                                  |
| `connect` | CNAME | `9de986619e5719be.vercel-dns-017.com.`        |
| `storage` | A     | `185.179.82.160`                              |
| `@`       | NS    | `a.ns.selectel.ru` through `d.ns.selectel.ru` |

The registrar delegates to the Selectel nameservers. The DNS records and
delegation were in place before TLS issuance and cutover.

## Production origins

The Wiki Vercel project uses:

- `WIKI_PUBLIC_ORIGIN=https://madhouse-wiki.ru`
- `VITE_TELEGRAM_CONNECTOR_ORIGIN=https://connect.madhouse-wiki.ru`
- `MADHOUSE_STORAGE_ORIGIN=https://storage.madhouse-wiki.ru/_madhouse-storage`

The connector Vercel project uses:

- `CONNECTOR_WIKI_ORIGIN=https://madhouse-wiki.ru`
- `CONNECTOR_PUBLIC_ORIGIN=https://connect.madhouse-wiki.ru`

The Wiki bot webhook is served at `https://madhouse-wiki.ru`; its menu URL also
opens that origin. The Telegram Bot API settings were updated after the custom HTTPS origins
became available.

## VPS storage and remaining work

The VPS storage service now handles private application storage for the
reference catalogue, raid schedule, encrypted raid Telegram session,
synchronization lease, analytics, and connector account-session data. Runtime
requests use the VPS storage service; there is no Vercel Blob runtime fallback
in this configuration.

The previous Vercel Blob store is suspended and its historical contents are
unavailable. The store has not been deleted. This does not imply that its old
objects have been recovered into the VPS storage service; only data present in
the current VPS storage is available to the application.

The Mac raid worker is disabled. The replacement VPS worker completed secure
Telegram authentication and its initial history reconciliation on 2026-10-23.
It runs as `madhouse-raid-worker` with automatic restart, receives channel
updates, and reconciles history every ten minutes. Startup was verified with
`raids_worker_ready`, zero restarts, and no OOM termination. The encrypted
session is backed up with the private storage data.

The storage endpoint remains behind the VPS nginx virtual host at
`/_madhouse-storage/`, forwarding to the loopback-only storage container. Do
not expose the container port publicly. Preserve the existing storage token,
encrypted Telegram session, and encryption keys while completing worker setup.

## Origin-scoped browser state

The new Wiki origin has a separate browser `localStorage` namespace, and the
new connector origin has separate browser `IndexedDB` state. Users may need to
sign in to the Wiki and establish the local Telegram connector session again
on these origins. Server-held account/session data is stored through the VPS
storage service and depends on retaining its existing encryption keys.

The Wiki and connector remain on Vercel. The private storage service remains
on the existing VPS.
