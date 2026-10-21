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

## Approved isolated connector release — 2026-10-20

The user explicitly approved public browser use of the existing Frontend Punks API_ID/API_HASH for the Wiki connection. This applies only to these two application parameters, not Telegram user sessions, IndexedDB state or other Frontend Punks data. Runtime configuration was set through the native Sites environment API, selecting only `apiId` and `apiHash` from the approved mode-600 local file. Both provider entries use `is_secret=true`; tool output contained key names, revision and masked-value booleans only. `/api/config` deliberately exposes these approved application parameters to the connector browser; they are not promised secret from visitors.

Separate connector identity is persisted in `connector/.openai/hosting.json`: `appgprj_6ad7d2c207c881918d41a93a70483788`. Authoritative expected HTTPS origin: `https://madhouse-connect.damir-tarasov2016.chatgpt.site`. Public audience is configured. Environment revision 1 contains only `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`; no Telegram user sessions or persistent server storage. No connector version has been published at this source checkpoint.

The connector Worker serves its own self-hosted JS/CSS/WASM with strict CSP, explicit `application/wasm`, exact Telegram WSS hosts and exact Wiki/Telegram Web frame ancestors. Its message boundary accepts only the immediate Wiki parent origin/source. Local generated Worker checks confirmed WASM 200, CSP on responses, missing runtime config 503/no-store and no COOP/COEP/shared-memory requirement.

Production release sequence: publish this non-secret metadata with the approved source, then build only from a clean checkout of that exact pushed SHA. Build the connector with `MADHOUSE_RELEASE_SHA=<source-sha>` and canonical `CONNECTOR_WIKI_ORIGIN`. In an isolated Sites provider envelope, use the connector hosting identity as the root `.openai/hosting.json`; preserve the original GitHub source separately. Sites source-helper commit SHA can differ due to this provider envelope, so record provider SHA, GitHub source SHA in `/release.json`, and final Worker artifact SHA256 as separate evidence. Never claim these distinct hashes are equal.

Publish and verify the connector before activating it in Wiki. Wiki's clean release build must explicitly use `VITE_TELEGRAM_CONNECTOR_ORIGIN=https://madhouse-connect.damir-tarasov2016.chatgpt.site` and pack with `MADHOUSE_REQUIRE_TELEGRAM_CONNECTOR=1`. The built config is checked for HTTPS/non-loopback origin; the ignored local proof `.env.local` must not enter the release checkout. Main Wiki hosting identity remains unchanged. Both services' release markers must identify the same reviewed GitHub source baseline and protocol version 1.

Hosted auth, native Telegram and phone behavior still require actual verification after publication. Earlier local auth limitations are historical: the auth owner subsequently demonstrated the official local browser MTProto/WebView/auth flow, automatic renewal and `/api/me` 200. Local proof does not establish hosted success.

### Public isolated connector and Wiki deployment verified

GitHub source baseline for both services: `dc9d2ae65dc338b39308cf110f876eed34500fac` (runtime source unchanged from reviewed candidate `f625e9759d45b0de07fed97ea1152a9b3a62b396`). Both builds used clean cloned checkouts and `npm ci` from the lockfile, without the ignored development `.env.local`. Actual public origins:

- Wiki: https://madhouse-wiki.damir-tarasov2016.chatgpt.site
- Isolated connector: https://madhouse-connect.damir-tarasov2016.chatgpt.site

Connector version 1 deployed successfully with environment revision 1:

- Deployment: `appgdep_6ad7d39316a48191b3733ca3a6ec8e0a`
- Saved version: `appgprj_6ad7d2c207c881918d41a93a70483788~appgver_64d05ab589788191bdffc879744cb269`
- Sites provider source commit: `5a6426b0189568c6b75b603497635145e8c41c20`
- Public marker GitHub source commit: `dc9d2ae65dc338b39308cf110f876eed34500fac`
- The only source-tree difference between provider commit and GitHub source is root `.openai/hosting.json`, which selects the separate connector identity. The provider identity was chosen before building; the source helper committed/pushed that unchanged state and packaged its artifact.
- Worker SHA256: `f73946902b926e36462b574575985ad368beb8d726d0c2db366171c65545b817`
- Saved archive content hash: `e4e1127bc89edf27ff6a4cff8abe5444dc9a7011692c3be8b0d9b10ad2cb30ed`

Wiki version 5 deployed after the connector passed public checks:

- Deployment: `appgdep_6ad7d3d02b288191b3e30d88e0c1677c`
- Saved version: `appgprj_6ad7c0c53f048191aed8251007907fe3~appgver_b207073e313081919b0b2fa8fcaf310c`
- Sites provider commit and public marker GitHub source commit both equal `dc9d2ae65dc338b39308cf110f876eed34500fac`.
- Worker SHA256: `1ff1feabdfd37be75641bd56ffe91eb685baae0f535143576fc1b1c7f0035e8f`
- Saved archive content hash: `2611be12570515de336c2436009bdb9fcaf16cc97683a81fac43902854d41770`
- `/release.json` and `/connection-config.json` both identify the actual connector HTTPS origin and protocol version 1. The build explicitly enabled that origin and required the production connector guard.

Public connector checks: root/release marker/both WASM assets return 200, WASM MIME is `application/wasm`, and CSP is present on API/static/error responses. Runtime config returns 200; boolean-only checks confirmed both parameters exactly match the two user-approved application parameters and the only response fields are apiId/apiHash/wikiOrigins. Neither parameter value was logged or saved into source/artifacts. The emitted Worker files were checked against the actual approved app hash and do not contain it. A malformed auth POST with an untrusted Origin returns 403; a malformed body from the connector Origin returns 400. API responses prohibit caching.

Public Wiki checks: marker/config match the GitHub source and actual connector origin; root, API docs, shared auth script and new JS/CSS assets return 200. Missing-session `/api/me` and encoded dollar-floor GET return 401. The auth owner independently confirmed the public Chrome Wiki UI and embedded isolated consent form. At this checkpoint the user handoff for real production Telegram login is pending: no successful hosted game auth, native reconnect or phone completion is claimed by these static/config/guard checks. Those require the auth owner's separate end-to-end evidence.

## Vercel migration preparation — 2026-10-21

The user requested moving both services from Sites to Vercel for regional accessibility. Coordinator owns the authorized Vercel browser/project operations; this track prepared deployment source without browser, Git index or push changes. Published migration source checkpoint: `dbafdfe48a3136781acd3550275ed4793c43e7c4`.

Both projects use the same repository root. Root `vercel.json` now declares `framework: null` and `buildCommand: npm run build:vercel`; leave the output-directory override disabled so Vercel consumes `.vercel/output` using Build Output API v3. Node 24 is required. The build refuses missing/unknown `MADHOUSE_SERVICE`, missing source SHA, missing/local/invalid production origins and identical Wiki/connector origins. On Vercel it takes source SHA from `VERCEL_GIT_COMMIT_SHA`; local packaging verification may explicitly supply `MADHOUSE_RELEASE_SHA`.

Required project configuration:

- Wiki: `MADHOUSE_SERVICE=wiki`, `VITE_TELEGRAM_CONNECTOR_ORIGIN=<actual connector HTTPS origin>`.
- Connector: `MADHOUSE_SERVICE=connector`, `CONNECTOR_WIKI_ORIGIN=<actual Wiki HTTPS origin>`, `CONNECTOR_PUBLIC_ORIGIN=<actual connector HTTPS origin>`; runtime-only approved `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`. Never use VITE variables for these two parameters.
- Both production URLs must be publicly accessible without Vercel deployment authentication. Exact origins must come from the actual provisioned projects, not guessed names.

Wiki packaging restores the published reference-only SQLite in a clean checkout and copies only its generated public Vite model/static assets. Its single Node API function reuses the existing read-only forwarding code and ships the OpenAPI documentation file at its expected relative path. It exposes no connector config or auth POST handler.

Connector packaging reuses `createConnectorApi` and `connectorHeaders` without changing auth behavior. Three bounded Node handlers cover config, game-session and unknown API requests. The adapter accepts streamed Node bodies and parsed Vercel bodies, enforces the existing 16KB bound, uses fixed build-time canonical origins, and forwards neither previous Bearer nor cookies to the game auth call. CSP/security headers apply to static/API/error responses; explicit API routing and response headers prohibit private caching. Static assets have separate cache rules and both WASM files have explicit `application/wasm` overrides. No COOP/COEP or new session storage was added.

Verification of the prepared source: nine focused proxy/Node-adapter tests passed, changed-file lint and diff checks passed. Tests cover runtime config/origin/CSP/no-store, raw and parsed POST equivalence, no previous Bearer/cookies, wrong origin/query/method/body/unknown routes and oversized input. Negative build probes rejected absent/invalid role, loopback HTTP origin and shared origin before building. Separate isolated Wiki and connector builds passed (110 and 813 modules); their packaged Node entrypoints imported successfully, returning Wiki missing-session 401/no-store and unconfigured connector 503/no-store+CSP. Local test origins were reserved example domains; this is packaging evidence, not live Vercel proof.

Remaining deployment acceptance: confirm actual Vercel domains and source SHA in both release markers, explicit main connection config, static JS/CSS/WASM types, API no-store/CSP and config boolean-only checks. In particular, verify `/api/me` and encoded dollar-floor routing on the deployed Wiki: the Build Output rewrite must preserve the original API request URL. Real public login/native/phone proof remains with the auth owner and is not inferred from adapter tests or successful builds. Existing Sites publications were not modified by this preparation.

### Vercel production migration — public HTTP verified

Actual public production origins, verified anonymously with curl:

- Wiki: https://madhouse-wiki.vercel.app
- Isolated connector: https://madhouse-connect.vercel.app

Both public release markers report source `dbafdfe48a3136781acd3550275ed4793c43e7c4` and provider Vercel. Wiki `/connection-config.json` and marker select the actual connector origin with protocol version 1. Connector marker identifies both actual canonical origins and protocol version 1. Runtime config boolean-only comparison confirms the exact two approved application parameters, with only apiId/apiHash/wikiOrigins fields and an exact single allowed Wiki origin. No parameter values were included in output or evidence files.

Coordinator's authorized Vercel UI reported main deployment `dpl_3btzeyvUScHXN9hf969we2TY6Uos` and connector deployment `dpl_6VkY5hw3KBYR8aGgna5YUjX6L2JL`, both from the migration source checkpoint. The initial main import was ready but staged: the production alias returned Vercel `DEPLOYMENT_NOT_FOUND` until coordinator explicitly promoted it. After promotion, the canonical Wiki URL passed all public checks. This was an alias/deployment state issue; no source fix was made.

Wiki production results: root, compiled JS/CSS, shared auth script, API-docs index and read-only OpenAPI return 200 with correct content types; `/api-docs` redirects 302 to index. `/api/me` and `/api/floors/%24/info` return 401 without a session; a deliberately invalid Bearer reaches upstream and returns real 401 without transport-error headers. POST `/api/me` returns 405 with Allow GET. API responses retain private/no-store and CDN no-store. The actual deployed rewrite preserves the original API URL, resolving the preparation-stage routing uncertainty.

Connector production results: root, entry JS, dynamic mtcute JS chunk and both WASM assets return 200 with appropriate JS/CSS/WASM content types. `/api/config` returns 200 with the correct runtime configuration, checked through booleans only. Unknown API returns JSON 404; GET game-session returns 405; malformed POST from an untrusted Origin returns 403; malformed POST from its own canonical Origin returns 400. CSP/security headers are present on root, API config and unknown API errors; API cache headers prohibit storage. CSP frame ancestors list the actual new Wiki origin and Telegram Web. No X-Frame-Options, COOP or COEP header was observed.

Auth owner initially observed a blank embedded frame, then recovered the complete consent/phone/QR UI after a normal reload. This was treated as a transient load/cache observation, not a source defect; no auth behavior was changed. Real Vercel account login, automatic renewal/reconnect and target-client/phone results require the auth owner's separate evidence and are not claimed by HTTP checks.

Coordinator confirmed the main Vercel project is connected to the GitHub repository. Subsequent Git pushes may therefore trigger Vercel deployment, unlike the earlier manual Sites pipeline. Evidence documentation remains a local draft until coordinator releases the publication hold; do not push documentation mid bot setup or auth verification. The existing Sites publications were not deleted or modified by this migration work. Bot URL migration is handled by the auth owner separately.
