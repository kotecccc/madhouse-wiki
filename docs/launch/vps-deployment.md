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
It keeps the prior Docker image tag available for rollback and does not prune
Docker images or modify storage backups. The verified download archive is held
only in a private temporary directory during deployment.

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
does not enable the timers or Nginx site. It creates the two mode-0600
environment files only when they do not already exist.

`/opt/madhouse-wiki/storage.env` holds the shared `MADHOUSE_STORAGE_TOKEN`.
`/opt/madhouse-wiki/wiki.env` requires the current production values for
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_WEBHOOK_SECRET`,
`WIKI_ADMIN_TELEGRAM_ID`, and `CRON_SECRET`.
`/opt/madhouse-wiki/connector.env` requires `TELEGRAM_API_ID`,
`TELEGRAM_API_HASH`, `WIKI_INITDATA_KEY`, and `ACCOUNT_SESSION_KEY`. These are
copied unchanged from their existing trusted source. Do not put values in
GitHub, image layers, release assets, command arguments, logs, or this
repository.

The Vercel Wiki build keeps its existing analytics Cron unless
`MADHOUSE_DISABLE_ANALYTICS_CRON=1` is set during that build. Set this only
after the public cutover has passed its checks, then create a new Vercel
production deployment before enabling the VPS cleanup timer.

## Cutover sequence

1. Install the runtime files on the VPS and populate both environment files
   with the existing production values. Do not change or rotate them.
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
