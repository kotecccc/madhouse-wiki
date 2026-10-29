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
release over HTTPS every 90 seconds (with up to five seconds of random delay), requires the expected tag and asset names, verifies the
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
check. The normal no-op when the latest SHA is already active remains quiet and does
not recheck release ancestry. Ancestry is checked before every transition.

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
- The app containers run as the Node user with a read-only root filesystem,
  no added capabilities, bounded memory and a temporary filesystem for Vite
  and Chromium runtime data. The Wiki image includes Puppeteer and its browser
  because Telegram bot cards use headless Chromium at runtime.
- Analytics, encrypted account sessions, connector sessions, and raid data
  continue to use the current authenticated VPS storage API. No Vercel Blob
  contents or VPS backups are imported or replaced.
- Nginx access logging is disabled for the Wiki and connector virtual hosts.
  The app does not log request bodies or credentials.

## Runtime configuration

`scripts/deploy/install-vps-runtime.sh` installs the Compose, Nginx, and
systemd definitions into `/opt/madhouse-wiki` and `/etc/systemd/system`. It
does not enable the timers or Nginx site. It creates the mode-0600 environment
files only when they do not already exist.

`/opt/madhouse-wiki/storage.env` holds the shared `MADHOUSE_STORAGE_TOKEN`.
`/opt/madhouse-wiki/wiki.env` requires the current production values for
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_WEBHOOK_SECRET`,
`WIKI_ADMIN_TELEGRAM_ID`, and `CRON_SECRET`.
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
