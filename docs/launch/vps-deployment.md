# Wiki and connector VPS deployment

## Migration state

The production Wiki and Telegram connector continue to serve from Vercel while
this migration is prepared. The VPS storage service and raid worker are
existing production services; this deployment does not rebuild, replace, or
modify either one. Production DNS remains unchanged until the VPS services,
runtime configuration, TLS, and private API checks all pass.

## Release flow

`.github/workflows/deploy-vps.yml` builds a Linux amd64 image from the exact
GitHub commit on `main`. Before publication it restores the tracked,
privacy-filtered reference catalogue, validates the data, runs the UI style
validator, ESLint, all Node tests, and both production builds. It then starts
the Wiki and connector containers without production credentials and checks
their release markers, static entrypoints, auth boundary, connector CSP, and
health endpoints.

The workflow publishes the image and SHA-256 checksum as a public GitHub
Release named `vps-<source-sha>`. The VPS release timer polls the public latest
release over HTTPS, requires the expected tag and asset names, verifies the
checksum, and loads the immutable image. Docker Compose waits for both
containers to become healthy. If a new image does not pass health checks, the
updater restores the previous release marker and starts the previous image.
Before activating a candidate, the updater stops the Wiki container and waits
16 seconds after the process has stopped, allowing its 15-second durable worker
lease to expire. The same stop-and-wait step runs before rollback, while the
candidate release marker still selects the candidate container. A failed stop or
wait aborts the transition before changing the release marker or starting another
worker. The lease and personal state are never deleted. First deployment uses
the candidate image SHA to resolve Compose without requiring a prior release file.

The updater records the previous successful source SHA atomically in
`/opt/madhouse-wiki/previous-release.env` (`MADHOUSE_PREVIOUS_RELEASE_SHA`). It
writes the rollback pointer before changing `release.env`, and restores the old
pointer when rolling back. On a legacy installation without this pointer,
automatic image cleanup stays disabled rather than guessing which release to
preserve. Before enabling cleanup on such a host, initialize this marker with the
verified previous successful SHA; never infer it from the newest downloaded image.
Before opening the update lock or contacting GitHub, the updater rejects a
symlinked or non-root-owned release directory. Each release, previous-release,
and rollback-floor marker must also be a regular non-symlink file owned by root
with no group or other write permission. A malformed or weakly protected marker
stops the update before release lookup.

### Rollback floor

After a bridge-aware R0 release has been installed and verified, the host may
record its full source SHA in the root-controlled
`/opt/madhouse-wiki/rollback-floor.env` as
`MADHOUSE_MINIMUM_SAFE_RELEASE_SHA=<40-character SHA>`. The floor lives outside
SQLite and is not part of account-state backups. When a new release is available,
the updater checks the current and candidate commits against GitHub's
commit-compare API and accepts only the floor commit itself or its descendants.
An unavailable, malformed, divergent, or older comparison fails closed before it
stops the Wiki. The current release is also checked before transition so a
restored or manually selected release below the floor cannot become the
automatic rollback target. An unchanged release is a no-op and does not query
commit comparison.

The floor is not written or advanced automatically. Set it only after the exact
R0 image is installed, healthy, and confirmed to preserve the bridge policy and
auth/action recovery schema. Until then the bridge route-selection gate remains
hard-disabled. If the floor marker is absent, the updater retains its legacy
release behavior; that state is not sufficient to activate bridge routing.

### Release compatibility and route-selection gate

The Wiki `/release.json` reports separate application, wire-protocol, pinned
protocol-package, server-schema and control-capability metadata, together with
the required host-configuration version, configured R0 SHA, rollback-floor SHA
and effective route-selection state. The Wiki Compose file supplies host
configuration version `1`; the updater passes a validated
`rollback-floor.env` into Compose so the running service reports the same floor
the updater enforces.

Route selection remains off unless `MADHOUSE_BRIDGE_ROUTE_SELECTION_ENABLED=1`
in the protected `wiki.env`, the runtime release SHA matches the installed
release marker, the minimum rollback floor equals
`MADHOUSE_BRIDGE_R0_RELEASE_SHA`, and the Compose host-configuration version
matches the release requirement. It also requires the operator to set
`MADHOUSE_BRIDGE_LEGACY_EGRESS_REVIEWED=1` after checking that every deployed
legacy direct game API has been retired or enforces the same owner route. The
flag records an operator attestation; it does not discover or verify external
deployments. `MADHOUSE_BRIDGE_STORAGE_CREDENTIAL_PATH_VERIFIED=1` is a second
operator attestation: the separately deployed private storage service must
support the narrow `game-credentials/<64-hex>.json` namespace and conditional
writes. The Wiki image updater does not install the storage server source, and
the flag cannot verify the installed server. Missing or inconsistent values keep the route
closed and are reported as a finite `disabledReason` in release metadata. The
provided `vps-wiki.env.example` sets the feature to `0` and leaves the R0 SHA
empty, and leaves the legacy-egress attestation at `0`. Do not enable these
values until the P9 readiness gate and the separate
pilot authorization are satisfied. This source gate does not prove the host
currently runs the installed Compose/Nginx files; that still requires the
read-only VPS inventory.

Space checks run against the temporary-download, deployment, Docker data and
containerd filesystems. The conservative minimum free space is 6 GiB before
download, 4 GiB before image load, and a 1 GiB reserve after load and before
stopping the working Wiki. If space is low, the updater removes eligible old Wiki
images and rechecks; insufficient space or unreadable disk/inventory information
aborts before stopping the services. A never-started, network-disabled probe
container verifies actual image unpacking before the worker stop, including
Docker implementations which return success despite an unpack error. The probe
and the private temporary download archive are removed when no longer needed.

Cleanup only removes tags matching `madhouse-wiki:vps-<40 lowercase hex digits>`,
without force. It preserves the current release, its previous successful release,
the candidate, and all immutable image IDs referenced by any existing container
(including stopped containers). It never invokes global Docker/image/system
prune or removes volumes, personal data, session keys, storage files or backups.
After healthy activation it also removes older eligible Wiki images, retaining
the new current and old current releases. Cleanup failure at that point is
reported without rolling back a healthy service. A shared `flock` prevents the
timer and manual maintenance from racing.

`/opt/madhouse-wiki/vps-release-update.sh --check-space` performs the 6 GiB space
check and, if necessary, the same constrained image cleanup without fetching a
release, loading an image or stopping/starting containers. This is an operational
maintenance command and can delete eligible image tags; it is not a read-only
check. The normal no-op when the latest SHA is already active remains quiet.

## Release notification

After a new release passes Compose startup checks, the updater runs
`scripts/deploy/release-notification.mjs` inside the Wiki container. It verifies
that Wiki and connector health endpoints both report the activated source SHA,
then sends one Telegram message to the existing `WIKI_ADMIN_TELEGRAM_ID` using
`TELEGRAM_BOT_TOKEN`. The message confirms service availability, not upstream game
API functionality. No message is sent for an unchanged release, space-only check,
or rollback. Notification failure is reported without rolling back a healthy
release; it is not retried automatically to avoid duplicates after a lost reply.
The host updater must be installed from the release source for this hook to run.

## Runtime layout

- `wiki` serves the React build and the existing Vercel-compatible API
  handlers on `127.0.0.1:9092`.
- `connector` serves the isolated connector build and the existing game and
  account-session handlers on `127.0.0.1:9093`.
- Nginx serves `madhouse-wiki.ru` and `connect.madhouse-wiki.ru` over HTTPS
  and proxies to those loopback-only ports. The storage virtual host remains
  unchanged.
- Both app containers use the existing storage origin at
  `https://storage.madhouse-wiki.ru/_madhouse-storage`; the Nginx storage
  route strips that public prefix before forwarding to the storage container.
- The Wiki Nginx source forwards `/bridge/` WebSocket upgrades to the loopback
  Wiki process with buffering disabled and bounded proxy timeouts. Control-WSS
  admission follows the protected release and route-selection gate; the source
  default keeps it closed. Prepared Nginx configuration is not evidence that it
  has been installed on the host.
- The app containers run as the Node user with a read-only root filesystem,
  no added capabilities, bounded memory and a temporary filesystem for Vite
  and Chromium runtime data. The Wiki image includes Puppeteer and its browser
  because Telegram bot cards use headless Chromium at runtime.
- Analytics, encrypted account sessions, connector sessions, and raid data
  continue to use the current authenticated VPS storage API. No Vercel Blob
  contents or VPS backups are imported or replaced.
- Nginx access logging is disabled for the Wiki and connector virtual hosts.
  The app does not log request bodies or credentials.
- On `SIGTERM` or `SIGINT`, each app server stops accepting HTTP and WebSocket
  upgrades. The Wiki runtime blocks new game API dispatches, asks connected
  desktop bridges to drain current streams and launch requests, and waits up to
  35 seconds before closing remaining HTTP and upgraded sockets. Compose grants
  both app containers 50 seconds before Docker sends a forced kill. These
  settings take effect only after the matching image and Compose configuration
  are installed; this change does not restart or update a VPS service.

## Runtime configuration

`scripts/deploy/install-vps-runtime.sh` installs the Compose, Nginx, and
systemd definitions into `/opt/madhouse-wiki` and `/etc/systemd/system`. It
does not enable the timers or Nginx site. It creates the mode-0600 environment
files only when they do not already exist.

`/opt/madhouse-wiki/storage.env` holds the shared `MADHOUSE_STORAGE_TOKEN`.
`/opt/madhouse-wiki/wiki.env` requires the current production values for
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_WEBHOOK_SECRET`,
`WIKI_ADMIN_TELEGRAM_ID`, and `CRON_SECRET`.
Wiki device approval also uses `MADHOUSE_BRIDGE_OWNER_PROOF_KEY`: a canonical
43-character base64url encoding of 32 random bytes. Generate it once and store
it only in the mode-0600 `wiki.env`; keep it stable across releases and never
put it in Git, image layers, logs, command arguments, or release assets. Without
this key, pairing requests can be created and queried, while approve/list/revoke
fail closed with `bridge_owner_auth_unavailable`.
The production runtime also hard-disables `route.select`; it has no environment
switch. Keep it disabled until the integrated tunnel and bridge-aware rollback
floor pass their readiness gates.
Device session challenge issuance also requires
`MADHOUSE_BRIDGE_SESSION_SIGNING_KEY`, a canonical base64url encoding of 32
random bytes. Keep it in the mode-0600 `wiki.env`, stable across Wiki instances
and releases, separate from the owner-proof key. It is not needed while route
selection remains disabled; setting it alone does not activate bridge routing.
Do not put it in Git, image layers, logs, command arguments, or release assets.
The auth-recovery coordinator can use `MADHOUSE_GAME_CREDENTIAL_KEY`, another
stable canonical base64url encoding of 32 random bytes, to encrypt the Cargo
credential in private storage. It must be separate from both bridge keys and
stable across releases; without it, desktop game-auth recovery remains
unavailable. This key is optional while the P5 runtime gate is closed. Do not
configure it until private storage, expiry/revocation handling, and the
integrated desktop-to-Wiki auth flow have passed their readiness review. Never
put it in Git, image layers, logs, command arguments, or release assets.
`/opt/madhouse-wiki/connector.env` requires `TELEGRAM_API_ID`,
`TELEGRAM_API_HASH`, `WIKI_INITDATA_KEY`, and `ACCOUNT_SESSION_KEY`. These are
copied unchanged from their existing trusted source.
`/opt/madhouse-wiki/raid.env` supplies `TELEGRAM_API_ID`,
`TELEGRAM_API_HASH`, and `TELEGRAM_RAIDS_SESSION_ENCRYPTION_KEY` to the
protected Wiki raid recovery endpoint, using the current raid worker values.
Do not put values in GitHub, image layers, release assets, command arguments,
logs, or this repository.

The Vercel Wiki build keeps its existing analytics Cron unless
`MADHOUSE_DISABLE_ANALYTICS_CRON=1` is set during that build. Set this only
after the public cutover has passed its checks, then create a new Vercel
production deployment before enabling the VPS cleanup timer.

## Cutover sequence

1. Install the runtime files on the VPS and populate the Wiki, connector,
   storage, and raid environment files with the existing production values.
   Do not change or rotate them.
2. Obtain a renewable certificate covering both `madhouse-wiki.ru` and
   `connect.madhouse-wiki.ru`. Keep the storage certificate and storage Nginx
   virtual host intact.
3. Fetch the latest release once with the systemd updater and confirm both
   services are healthy on their loopback ports. Check the VPS API against the
   current storage service using an authorized API session; confirm no
   credentials, personal session data, or storage backup files are returned.
4. Enable the Nginx site and test both HTTPS origins with `curl --resolve`
   pointed at the VPS address. Check release markers, connector CSP/config,
   the no-session API response, storage access, and Telegram webhook status.
5. Change the apex and connector records to the VPS address. Keep the
   `storage` record unchanged and retain both Vercel projects for rollback.
   Recheck DNS over HTTPS and repeat the production HTTP/API smoke checks.
6. After the public cutover is healthy, set
   `MADHOUSE_DISABLE_ANALYTICS_CRON=1` in Vercel Production and create a new
   production deployment. Confirm that deployment has no analytics Cron
   while retaining Vercel's HTTP deployment for rollback. Then enable
   `madhouse-wiki-release.timer` and `madhouse-wiki-cleanup.timer`; the
   cleanup timer replaces the existing daily `04:17 UTC` job.

No Vercel project, Blob store, deployment, VPS storage file, or backup is
deleted as part of the migration. Rollback changes only the Wiki and
connector DNS records back to their previous Vercel targets; the VPS services
and their stored state remain available for diagnosis.
