# Custom domain cutover preparation

The intended public origins are:

- Wiki: `https://madhouse-wiki.ru` (apex domain, served by the existing Wiki
  Vercel project).
- Telegram connector: `https://connect.madhouse-wiki.ru` (served by the
  existing isolated connector Vercel project).
- Private object storage: `https://storage.madhouse-wiki.ru/_madhouse-storage`
  (existing storage service on the VPS, behind nginx).

On 2026-10-22, the Wiki and connector custom domains were attached to their
Vercel projects and the records below were added in Selectel. The registrar
already had the correct Selectel nameservers. Public DNS still returned
NXDOMAIN, so TLS issuance and the canonical-origin cutover remain pending.
Production environment variables and Telegram URLs still use the working
previous origins until all three new HTTPS endpoints are available.

## DNS configuration verified in Selectel

The Selectel zone is configured with these records:

| Name      | Type  | Target                                        |
| --------- | ----- | --------------------------------------------- |
| `@`       | A     | `216.198.79.1`                                |
| `@`       | A     | `64.29.17.1`                                  |
| `connect` | CNAME | `9de986619e5719be.vercel-dns-017.com.`        |
| `storage` | A     | `185.179.82.160`                              |
| `@`       | NS    | `a.ns.selectel.ru` through `d.ns.selectel.ru` |

Public DNS returned NXDOMAIN while registration or delegation propagation is
pending. Recheck authoritative and public DNS before attempting TLS issuance.
A record visible in the
Selectel control panel does not establish that the parent registry delegation
is active.

## Vercel configuration after DNS and TLS are ready

Add `madhouse-wiki.ru` to the existing Wiki Vercel project and
`connect.madhouse-wiki.ru` to the existing connector project. Confirm both
custom domains serve the current production deployments over valid HTTPS
before changing any canonical origin. Keep the two projects separate.

Set Production variables on the Wiki project:

- `WIKI_PUBLIC_ORIGIN=https://madhouse-wiki.ru`
- `VITE_TELEGRAM_CONNECTOR_ORIGIN=https://connect.madhouse-wiki.ru`
- `MADHOUSE_STORAGE_ORIGIN=https://storage.madhouse-wiki.ru/_madhouse-storage`
- Keep `MADHOUSE_STORAGE_TOKEN` unchanged and configured.
- Keep the Wiki Vercel Blob connection and `BLOB_STORE_ID`; analytics still
  reads and writes Vercel Blob directly.

Set Production variables on the connector project:

- `CONNECTOR_WIKI_ORIGIN=https://madhouse-wiki.ru`
- `CONNECTOR_PUBLIC_ORIGIN=https://connect.madhouse-wiki.ru`
- Keep `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `WIKI_INITDATA_KEY`, and
  `ACCOUNT_SESSION_KEY` unchanged.
- Keep the connector's Vercel Blob connection. Connector account-session
  records still use Vercel Blob directly.

Build and deploy the connector first, then the Wiki with its matching connector
origin. The connector's CSP and API origin checks use the configured Wiki
origin, while the Wiki embeds the connector origin at build time. Verify both
release markers and the Wiki connection config after deployment. The existing
VPS storage service is separate from Vercel: update its nginx virtual host and
TLS certificate for `storage.madhouse-wiki.ru`, while preserving the
`/_madhouse-storage/` route to the loopback-only storage container. Do not
expose the container port publicly.

The storage service serves the reference catalogue, raid schedule, encrypted
raid Telegram session, and synchronization lease. Wiki analytics and
connector account sessions remain direct Vercel Blob dependencies. The Mac
raid worker should use the same `MADHOUSE_STORAGE_ORIGIN` and existing token;
its next live synchronization still waits for Telegram authentication. Keep
the existing encrypted session and lease intact during the cutover.

## Telegram cutover, after all three HTTPS origins work

Only after the Wiki, connector, and storage origins have valid TLS and pass
their service checks, set these Production values for the Wiki bot API:

- `WIKI_PUBLIC_ORIGIN=https://madhouse-wiki.ru`
- `TELEGRAM_BOT_WEBHOOK_ORIGIN=https://madhouse-wiki.ru`

Then run the existing bot configuration command from a protected local
environment. It updates the bot's menu URL and registers the webhook at the new
Wiki origin. Update BotFather's Login Widget domain to `madhouse-wiki.ru` as
well. Do not run the command while the apex origin or webhook is unavailable;
that would move Telegram traffic to an unready deployment. Do not print or
commit bot tokens, webhook secrets, storage tokens, or encryption keys.

The new Wiki origin has a separate browser `localStorage` namespace, and the
new connector origin has separate browser `IndexedDB` state. Existing browser
JWT and local Telegram connector state will therefore need to be established
again on the new origins. Preserve the server-side connector Blob data and all
encryption keys so server-held account sessions remain readable.

## Acceptance checks

After each service is deployed, check its public release marker and expected
static/API responses. Confirm the connector CSP names the apex Wiki origin;
the Wiki connection config names the connector subdomain; Wiki API responses
remain private/no-store; and the storage service rejects unauthenticated
requests. Then check `/api/catalogue` and `/api/raids?limit=1` on the public
Wiki. Run the Telegram webhook/menu update only after these checks pass.

This cutover changes custom domains and service origins only. The Wiki and
connector remain on Vercel, and private object storage remains on the existing
VPS.
