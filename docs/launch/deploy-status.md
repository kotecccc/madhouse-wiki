# Hosting / Track B

Date: 2026-10-20. Status: public HTTPS site and production GET forwarding verified; valid game-account reads remain unverified because no fresh game session could be obtained.

## Source and catalogue

Repository: https://github.com/kotecccc/madhouse-wiki. Checkpoint: `86f488cff0f7b4f28c56187e75771a356173f551`.

Node 24 is required (`node:sqlite`). `npm run catalogue:package` creates `catalogue/reference.sqlite` from the canonical ignored `local-data/madhouse.sqlite`. It creates a new database, reprojects every entity through the existing strict per-kind allowlists and copies only reviewed reference entities, relationships, source metadata, route discovery and route/status/count/time coverage. It excludes raw `source_documents`, `entity_observations`, private database pages and free-form capture notes. API operations are already public OpenAPI documentation and are not needed by the React query model.

Export audit: 4821 entities, 1829 relationships, 500 source metadata rows, 535 coverage rows, 239 discovery rows; source_documents=0, no entity_observations table. Integrity and FK checks pass. All existing entity JSON fields match reference projection. Manual source metadata review found API path locators, public route provenance, and the explicitly authorized user-provided reference costs/sequence notes. The safe user reference source remains in GitHub; other local captures stay ignored.

`npm run build:hosted` restores the published seed only if the canonical SQLite is absent, then runs the existing SQL/Vite virtual module. A clean isolated source copy with no private local-data passed: 106 modules, approximately 134KB gzipped JS. It does not publish the SQLite as a served static asset.

## Production API transport

The transport supports only GET paths declared in the existing read-only OpenAPI contract. It always targets `https://cargohustle.online`, requires the caller's Bearer game session, forwards only Authorization and JSON Accept, never follows redirects and rejects all upstream 3xx responses, and forwards no user cookies or upstream Set-Cookie. Every success/error response has private/no-store and CDN no-store headers. No credentials or personal API responses are logged, persisted or built into the catalogue.

The Vercel adapter is `api/[...path].js`; `vercel.json` includes the OpenAPI file in function tracing, API-docs redirect and SPA routing. The Fetch API transport in `scripts/deploy/production-api.mjs` also runs in Sites Worker. Six focused proxy tests pass, covering denied routes/writes/missing sessions, bounded fixed forwarding, no cookie/cache leakage, status/429 preservation sanitized network failure, encoded dollar-floor identifiers and unconditional 3xx rejection without Location/secret leakage.

## Provider selection

Vercel Hobby is free for personal projects: https://vercel.com/docs/plans/hobby. Existing CLI authentication was rejected (`specified token is not valid`); fresh login requires user authentication. Chrome and IAB attempts to open dashboard failed with ERR_CONNECTION_RESET, while shell HTTPS probes succeeded. No Vercel project or billable resource was created. Vercel config remains ready for later use.

Sites fallback published with public audience: project `appgprj_6ad7c0c53f048191aed8251007907fe3`, live origin `https://madhouse-wiki.damir-tarasov2016.chatgpt.site`. `.openai/hosting.json` persists the identity. Source-repository credentials are held only in tool-session memory and passed through the Sites source helper stdin. Deployment packaging runs in a separate temporary checkout, leaving the shared project's Git index to Track A.

The Sites Worker serves the unchanged React/Vite assets and the same GET transport. `scripts/deploy/build-sites.mjs` embeds the built assets, excludes private catalogue input, and emits `/release.json` with `MADHOUSE_RELEASE_SHA` identifying the pushed GitHub source commit. No D1/R2/persistent backend is provisioned.

## Verified production release

Live URL: https://madhouse-wiki.damir-tarasov2016.chatgpt.site

Verified runnable source SHA: `cff5288b21dc08d7f059aa261a7422ead5f939b3` (GitHub main and Sites source repo match). A clean clone of the pushed GitHub source was built and packaged with the Sites source helper. The helper confirmed the same SHA, then Sites saved version 3 and deployed it successfully:

- Version: `appgprj_6ad7c0c53f048191aed8251007907fe3~appgver_dd8770572d308191a319ea1f31c03274`
- Deployment: `appgdep_6ad7c32e35248191ac77bbba732ff356`
- Provider deployment: `site---6ad7c0c53f048191aed8251007907fe3`
- Archive SHA256: `1ea16265af56b93e1da520a3e85c9b91ed915b215441bad051350d4425c51900`
- `/release.json` publicly reports the exact source repository/SHA. Consult it for subsequent evidence-only release commits.

Public curl checks: root 200 HTML; generated JS/CSS 200 with correct types; `/auth-session.js` 200 JavaScript; `/api-docs` 302 to index; documentation index and read-only OpenAPI 200. Missing-session GET `/api/me` and `/api/floors/%24/info` return 401; POST returns 405 with Allow GET. Controlled deliberately invalid Bearer on both routes reaches the real game API and returns upstream 401 with private/no-store and CDN no-store headers, no Location and no transport-error header. No real game token or account data was used in those checks.

Earlier strict `redirect:error` requests produced 502 and the fixed diagnostic enum `upstream-redirect-rejected`; this disproved the initial runtime/cache incompatibility hypothesis. The final explicit manual/no-follow policy rejects every upstream 3xx itself and never forwards Location or credentials to a redirect target. The final controlled requests returned upstream 401. Whether earlier redirects were transient upstream protection or a runtime behavior difference is not established; do not state a guessed cause as fact. Safe enum-only diagnostics remain available for actual future failures.

Anonymous IAB browser rendered all 16 floor controls and actual A1/A2/A3 catalogue names and energy values. At mobile 390x844, there was no horizontal overflow (document width 390, scroll width 379), four floor columns, and all three visible stash images loaded with naturalWidth 122 after one ordinary reload. Initial external CDN failures were transient; no asset paths were changed. Public-only screenshot: `artifacts/launch/production-mobile.png` (intentionally ignored by Git). Coordinator independently verified floor disclosure and boss-drop modal content. Root response has neither X-Frame-Options nor CSP embedding restrictions.

Python urllib is intermittently rejected by provider Cloudflare error 1010 while curl and normal browser access succeed. Provider edge can inject its own `__cf_bm` cookie; the application never forwards upstream game cookies. Network resets also affected local browser/probe attempts, so individual failed probes are not treated as global availability claims.

## Releasing again

Track A owns GitHub source commits/pushes. From a clean checkout of the exact pushed commit, install locked dependencies with Node 24, run `npm run build:hosted`, then `MADHOUSE_RELEASE_SHA=<exact-pushed-sha> node scripts/deploy/build-sites.mjs` for the Sites Worker. The source helper must push that exact source state to the existing Sites source repository and package the Worker; credentials go only through hidden stdin. Save the returned archive/SHA as a version and deploy the returned version ID. Preserve `.openai/hosting.json` project identity and current public audience. Verify `/release.json`, API no-store behavior and any changed UI. Do not run the Worker packager against the shared local development dist; use an isolated release checkout.

Sites is synchronized from the GitHub source through this release procedure; automatic deployment on every GitHub push is not configured. Vercel config remains available if the user later authenticates Vercel. No paid resources, custom domain, database service or persistent connector was provisioned.

## Remaining limits

The existing manual-JWT feature now has a production GET transport. A successful authorized account response has not been tested: Track C obtained fresh official Mini App initData twice, but the game's auth exchange returned 401, so no fresh valid game session exists for this proof. The separate Telegram bot menu/domain is configured by Track C; embedded Telegram rendering remains unverified despite the public site working, and must not be described as a working game-account connector.

Neither Vercel functions nor this Sites Worker run a persistent MTProto session or provide durable local SQLite writes. No such backend is claimed. This track's public deployment, reproducible reference catalogue and production forwarding/error guards are delivered; the overall account-connection goal remains subject to Track C's upstream auth blocker.
