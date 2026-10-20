# Hosting / Track B

Date: 2026-10-20. Status: production packaging in progress; no public deployment verified yet.

## Source and catalogue

Repository: https://github.com/kotecccc/madhouse-wiki. Checkpoint: `86f488cff0f7b4f28c56187e75771a356173f551`.

Node 24 is required (`node:sqlite`). `npm run catalogue:package` creates `catalogue/reference.sqlite` from the canonical ignored `local-data/madhouse.sqlite`. It creates a new database, reprojects every entity through the existing strict per-kind allowlists and copies only reviewed reference entities, relationships, source metadata, route discovery and route/status/count/time coverage. It excludes raw `source_documents`, `entity_observations`, private database pages and free-form capture notes. API operations are already public OpenAPI documentation and are not needed by the React query model.

Export audit: 4821 entities, 1829 relationships, 500 source metadata rows, 535 coverage rows, 239 discovery rows; source_documents=0, no entity_observations table. Integrity and FK checks pass. All existing entity JSON fields match reference projection. Manual source metadata review found API path locators, public route provenance, and the explicitly authorized user-provided reference costs/sequence notes. The safe user reference source remains in GitHub; other local captures stay ignored.

`npm run build:hosted` restores the published seed only if the canonical SQLite is absent, then runs the existing SQL/Vite virtual module. A clean isolated source copy with no private local-data passed: 106 modules, approximately 134KB gzipped JS. It does not publish the SQLite as a served static asset.

## Production API transport

The transport supports only GET paths declared in the existing read-only OpenAPI contract. It always targets `https://cargohustle.online`, requires the caller's Bearer game session, forwards only Authorization and JSON Accept, rejects redirects, and forwards no user cookies or upstream Set-Cookie. Every success/error response has private/no-store and CDN no-store headers. No credentials or personal API responses are logged, persisted or built into the catalogue.

The Vercel adapter is `api/[...path].js`; `vercel.json` includes the OpenAPI file in function tracing, API-docs redirect and SPA routing. The Fetch API transport in `scripts/deploy/production-api.mjs` also runs in Sites Worker. Three focused proxy tests pass, covering denied routes/writes/missing sessions, bounded fixed forwarding, no cookie/cache leakage, status/429 preservation and sanitized network failure.

## Provider selection

Vercel Hobby is free for personal projects: https://vercel.com/docs/plans/hobby. Existing CLI authentication was rejected (`specified token is not valid`); fresh login requires user authentication. Chrome and IAB attempts to open dashboard failed with ERR_CONNECTION_RESET, while shell HTTPS probes succeeded. No Vercel project or billable resource was created. Vercel config remains ready for later use.

Sites fallback registered (not yet published): project `appgprj_6ad7c0c53f048191aed8251007907fe3`, expected origin `https://madhouse-wiki.damir-tarasov2016.chatgpt.site`. `.openai/hosting.json` persists the identity. Source-repository credentials are held only in tool-session memory and passed through the Sites source helper stdin. Deployment packaging runs in a separate temporary checkout, leaving the shared project's Git index to Track A.

The Sites Worker serves the unchanged React/Vite assets and the same GET transport. `scripts/deploy/build-sites.mjs` embeds the built assets, excludes private catalogue input, and emits `/release.json` with `MADHOUSE_RELEASE_SHA` identifying the pushed GitHub source commit. No D1/R2/persistent backend is provisioned.

## Limits and remaining checks

A public URL, deployment ID, final source SHA, mobile/assets/catalogue and real production API behavior remain to be verified after publication. Existing manual JWT sessions can use the GET transport; a fresh Telegram connector and POST auth exchange are separate Track C work. Neither Vercel functions nor this Sites Worker run a persistent MTProto session or provide durable local SQLite writes. No such backend is claimed.
