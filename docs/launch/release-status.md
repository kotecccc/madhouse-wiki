# Madhouse Wiki release status

Date: 2026-10-20 (Europe/Minsk). Public reference site, bot and native Telegram rendering are verified. A fresh official-game exchange and an authenticated production read are now proven. Automatic or one-button login from Wiki remains unimplemented; dedicated research continues, including a separately authorized investigation of a full Telegram user-session login. The earlier 401-only blocker is superseded.

## Current production-parameter authorization

The human explicitly approved in the auth chat: «Разрешаю использовать API_ID/API_HASH Frontend Punks публично в подключении Wiki». This supersedes the earlier LOCAL-ONLY restriction recorded in historical research notes below. Scope is exactly those two application parameters in the public browser connector runtime configuration. It does not include STRING_SESSION, another account's login, Telegram user-session export, personal data in Git, or paid resources. Parameter values must still stay out of commits, build artifacts and tool/log output; browser visibility through the approved runtime endpoint is intentional and disclosed.

The deployment track is authorized to create the separate free connector Site, configure only those runtime parameters, bind its real HTTPS origin to the Wiki build and deploy the reviewed source. No further duplicate permission question is needed for this exact approved exposure. Source audit, exact-SHA clean builds, public production login, all target clients, renewal and logout checks remain required; the local proof alone does not complete the release. Historical statements below that production permission was pending describe the earlier checkpoint and are superseded by this section.

## Public deliverables

- Website: [Madhouse Wiki](https://madhouse-wiki.damir-tarasov2016.chatgpt.site/).
- Repository: [kotecccc/madhouse-wiki](https://github.com/kotecccc/madhouse-wiki), public, branch `main`. Repository homepage points to the live website.
- Bot: [@MadhouseWikiBot](https://t.me/MadhouseWikiBot). Its WebApp menu, descriptions and BotFather domain point to the live website.
- Release marker: [release.json](https://madhouse-wiki.damir-tarasov2016.chatgpt.site/release.json).
- Independently verified final pushed/deployed release: `cdc92f24b3562b06d644546823cfcda499d4d1ea`. Sites v4 deployment: `appgdep_6ad7c3c4d4c88191bd3f7293888760b5`. Runtime/test code is identical to tested baseline `cff5288b21dc08d7f059aa261a7422ead5f939b3`; only four status documents differ. The live release marker is authoritative for the actual deployed SHA.

## Acceptance by layer

| Layer                 | State                                                 | Evidence and limits                                                                                                                                                                                      |
| --------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub                | Verified                                              | Correct owner, public API/SSH pushed SHA checks, reviewed publication scope and established user authorship                                                                                              |
| Catalogue             | Verified                                              | Audited reference-only SQLite seed; isolated clean hosted build without private local-data                                                                                                               |
| Public website        | Verified                                              | HTTPS renders the actual React catalogue; assets, API docs and disclosure/drop modal work; mobile 390×844 checked                                                                                        |
| Production API guards | Verified                                              | No-session me/dollar-floor 401; writes 405; unknown routes rejected; no-store responses                                                                                                                  |
| Upstream forwarding   | Authenticated read verified                           | New JWT from a clean official exchange used for production /api/me: 200, strict JSON object, private/no-store/max-age=0; token/profile not persisted or output                                           |
| Telegram bot          | Configured                                            | Bot API identity/menu/description getters, domain and public profile confirmed. Actual catalogue rendering inside the native Telegram Desktop Mini App is visually verified after explicit user approval |
| Fresh game connection | Official exchange verified; Wiki bootstrap unresolved | Same-context comparator: Wiki bot initData age5s -> 401/no token; official game initData age0s -> 200/new JWT and me200. Wiki automatic login is not implemented                                         |
| Final integration     | Final source/deployment verified                      | Final clean exact-source deployment, matching public GitHub/release marker and API smoke checks passed                                                                                                   |

The Wiki bot is a website entry point. No persistent bot worker, conversational start handler, hosted MTProto service or automatic game connector is deployed. A clean official game login and authenticated production GET are now proven; this does not establish automatic login from the Wiki bot. Existing manual-JWT UI is preserved.

## Verification

- Final coordinator test run on deployed source: **49 passed, 0 failed**, including four proof CLI and six production transport checks. Final lint, data validation and diff check passed. HMR port contention was a non-fatal test-run warning.
- Coordinator lint and data validation passed: SQLite integrity ok, zero unresolved links, 16 floor definitions and 108 bosses.
- Aggregate formatting check reported 12 existing application/API/script/test formatting warnings, plus this document before formatting. No unrelated formatting churn was introduced; full aggregate check is not claimed.
- Seed audit: 4,821 entities, 1,829 links, 500 sources, 535 route/status/count/time coverage records and 239 discovery records. Raw source documents are empty, observations absent, integrity/FK checks pass. Fresh database export reprojects payloads through reference allowlists; source metadata was manually reviewed by tracks A/B.
- Track B built a clean clone of the pushed source, embedding the original React/Vite assets with a fixed-upstream GET Worker. Private SQLite is not served; provider checkout/publish is isolated from the project's Git index.
- Coordinator independently read GitHub commits and live release marker: source repository/SHA matched. Browser interactions opened A1 boss/business content and the drop modal with reference costs/stats.
- Root, JS/CSS, auth-session.js, API docs/OpenAPI return 200; docs redirect works. Mobile width 390 has no horizontal overflow. External CDN images loaded after one normal reload; coordinator confirmed visible stash image width 122. No asset path/source changes were needed.
- Python urllib encountered provider Cloudflare filtering and Chrome occasionally reset connections. Curl and the in-app browser successfully verified public deployment; local client filtering is separate from upstream game auth.
- No-session API guards are independently confirmed with curl. Earlier invalid-Bearer probes returned 502 and the fixed diagnostic identified rejected upstream redirects. Final source uses manual mode and unconditionally rejects every redirect without following it or forwarding Location/Bearer. The final public deployment independently returns actual upstream 401 for a controlled invalid token with no-store headers and no transport-error header. The earlier cause is not conclusively attributed to cache/runtime incompatibility; no redirect was bypassed. Fixed diagnostic enums contain no requests, credentials, URLs, bodies or raw errors.
- Telegram Web observation initially had an accessibility/screenshot mismatch. A later native Desktop check after explicit user approval visually confirmed the real catalogue inside the Wiki Mini App; see the resolution below. Standalone responses have no CSP/X-Frame-Options blocking embedding.
- Coordinator CORS preflight to the fixed game API with the Wiki Origin returned 204 without Access-Control-Allow-Origin/Headers/Methods, so direct browser forwarding was not substituted.
- Track C obtained fresh official-game launch data through existing authorized Telegram Web. Two direct clean auth probes returned 401; the official client's own auth request was not captured. Protected local proof CLI is diagnostic only. No fabricated signature, developer-ID shortcut, gameplay write or new Telegram device session was used.

Public mobile screenshot: `artifacts/launch/production-mobile.png` (ignored local verification artifact).

## Security and coordination

Track A owns Git index/commits/pushes; B hosting/catalogue packaging/transport; C Telegram/BotFather/proof; coordinator this file and independent integration checks. Cross-chat messages are explicitly authorized by PLAN.md. No extra agents were created.

Workspace/root and initial dirty main were checked before work. Existing authorized UI/catalogue work was preserved and published after audit. No reset, stash, clean, checkout, force push or unrelated project changes. Initial HEAD was f47a7ce073f28516b2fdf1995cb4d723422d5251; first checkpoint 86f488cff0f7b4f28c56187e75771a356173f551.

GitHub creation used the existing macOS Git credential helper in memory after owner verification, without printing or persisting credentials. Publication audits found no credential material. Raw captures, private SQLite, environment/session files stay excluded. Bot secrets are outside the repository with restrictive permissions. Track C's status records handling of a temporary signed launch URL in a private tool result; it was never published/committed and must not be copied.

An unrelated project's MTProto session resolved to a different identity and was excluded from Wiki creation/game login; its temporary helper was removed. The authorized active Telegram account created/configured the bot. No paid plan, domain purchase, D1/R2 or persistent user-session service was provisioned. Vercel auth was unavailable; Sites supplied the provider subdomain.

See github-status.md, deploy-status.md and telegram-status.md for detailed evidence. Push, deployment, bot setup and game connection are separate claims.

## Native Telegram continuation audit (historical pre-approval state)

After the final release, a bounded check through the existing authorized Telegram Desktop account reached the actual Wiki bot menu and its native launch confirmation. Clicking Launch explicitly accepts Telegram Terms of Service for Mini Apps. Launch was not clicked: the Computer Use Confirmation Policy requires action-time confirmation for legally binding agreements, so an explicit user approval request is pending. No new Telegram session, game launch, initData retrieval or authentication probe occurred in this check.

The modal remains pending. Embedded rendering is therefore unverified with a concrete next step: user approval of that Launch action, then a visual check. This is separate from the two clean upstream game-auth 401 responses. Safe cropped review artifact, outside Git: `/Users/mac/.codex/visualizations/2026/10/20/01a15ac6-79c9-7380-a665-810eaa1daf3c/native-wiki-launch-confirmation.png`.

## Blocked audit disposition (before Launch approval)

The same fresh-game-auth blocker persisted across the original launch turn and two consecutive coordinator goal continuations: no new game JWT or authenticated me proof exists. Current sanitized evidence was re-read: authStatus 401, authRequestHadBearer false, authAgeSeconds 28, private proof mode 0600. The current official public client bundle was also audited: it sends the original Telegram initData as JSON to the documented endpoint; optional previous Bearer and default same-origin cookie behavior do not establish a clean successful login. The backend rejection reason remains unknown. Repeating the same probes, collecting another account's Telegram session, inventing signatures or adding an unproven connector would not resolve this evidence gap.

A fresh read-only native UI audit confirms the Wiki Launch/Terms dialog is still present, with no user-completion evidence. No human approval has arrived. This separately prevents the remaining embedded visual check. All independent publication, hosting, catalogue, transport-guard and bot configuration work is complete and verified. No live build, deployment job or other useful external process remains to wait on.

Next required changes are explicit approval of the pending native Wiki Launch action (for embedded visual verification), and a supported or demonstrably successful fresh official-game auth exchange (for actual account connection). A valid game JWT supplied through the normal Wiki login could separately verify authenticated GET transport, but would not prove or implement automatic Telegram-to-game connection. Goal disposition: blocked, not complete. This continuation note is local coordinator status; the published code release remains cdc92f24b3562b06d644546823cfcda499d4d1ea.

## Native launch approval resolved

The human explicitly answered the coordinator approval request: permission to click Launch and accept Telegram Terms of Service for Mini Apps. The user also completed Launch themselves in the Telegram chat before a duplicate click was attempted. A fresh read-only native Desktop check confirmed a Mini App window named Madhouse Wiki with the actual React catalogue: Wiki header, login button, all 16 floor selectors, A1/A2/A3 work cards with reference energy costs, and the Wiki bot footer. No Terms dialog remains; no duplicate acceptance was needed.

Safe current screenshot, outside Git: `/Users/mac/.codex/visualizations/2026/10/20/01a15ac6-79c9-7380-a665-810eaa1daf3c/native-wiki-rendered.png`. Coordinator independently viewed it. Item thumbnails are blank placeholders in this particular native capture, so it proves embedded catalogue rendering, not successful loading of every image. Public browser image loading was separately verified earlier.

This resolves the native embedded-rendering acceptance item and the pending Launch approval. The previous blocked audit's Launch-related condition is superseded. Fresh official-game authentication remains the only unresolved account-connection condition: the recorded clean exchange returned 401 and produced no new JWT. No game was opened and no authentication/initData/session operations were performed for this native visual check. Published application code remains unchanged.

## Successful fresh exchange and production read (supersedes old auth blocker)

The dedicated auth chat performed a controlled same-context comparison on 2026-10-20. Both auth requests used JSON {initData}, credentials omitted and no previous Authorization header. Wiki bot launch data aged 5 seconds returned 401 telegram_auth_failed and no token at 20:03:00.265 UTC (23:03:00.265 Europe/Minsk). Official game launch data aged 0 seconds returned 200 and a new accessToken at 20:03:45.637 UTC (23:03:45.637 Europe/Minsk). Only this new JWT authenticated the official /api/me, which returned 200 and a strict non-array JSON object.

The same JWT, held only in memory, then authenticated production Wiki /api/me at 20:03:55.117 UTC (23:03:55.117 Europe/Minsk): 200, strict JSON object, Cache-Control private/no-store/max-age=0. Tokens/profile were not printed, persisted or placed in the catalogue. Token exp-minus-now was observed as 86400 seconds for this issuance; no fixed refresh/revocation or permanent lifetime contract is inferred. Telegram had reused an earlier iframe in some tests; the exact age limit and cause of every historical 401 remain unknown.

The report and current scope are in [auth-connection-research.md](../auth-connection-research.md). Coordinator reviewed the report's comparator method, strict object assertion, absence of old Bearer/cookies, public client source evidence and limits. It explicitly distinguishes successful official-game exchange from the missing Wiki-to-game bootstrap. The companion's observed manual secret transfer/device bridge does not meet the requested UX. Searches finding no callback strings in the current public bundle do not prove absence of all private server capabilities.

The user requires ordinary Telegram on phone, Desktop and Web, without installing extensions/bridges. The user subsequently permitted investigation of a separate full Telegram login inside Wiki after its broad account scope was explained. This is research permission, not a completed login, game-only permission or blanket approval of future security prompts. No new user session or device login has yet been created. Implementation/runtime/storage/expiry and end-to-end cross-platform behavior must be proven before adding automatic-login UI. Exclusive Telegram UI ownership belongs to auth chat 01a15ae4-3b7e-70c1-8c6c-b32ebf877c97.

## Later relay proof and isolated Telegram-client research

Subsequent controlled checks support observed single-use behavior of the tested initData. At age 0, one payload succeeded first in the official browser and was rejected both by a later local-server request and by a repeated browser request. In a second diagnostic launch, the official app script was temporarily prevented from racing the exchange. The local Node relay exchanged that fresh payload first at 2026-10-20 20:09:13.441 UTC (23:09:13.441 Europe/Minsk): auth200/new JWT and me200/strict object. A later browser exchange of the same payload was rejected. The temporary diagnostic blocking was removed and the tab closed. This supports single-use for these observations, without asserting a full replay or maximum-age specification. Production product flow does not block official scripts.

An isolated React/mtcute browser prototype outside the repository passed its build and a real unauthenticated WebSocket help.getConfig call. Login using the public test application parameters is disabled. User login, restoration, fresh game launch, repeat login and logout/revocation remain untested with the user's own Telegram API application; my.telegram.org/apps requires the user's login. A human handoff request is pending in the dedicated auth chat. No new Telegram user session has been created. The private prototype is not publication input.

Before integration, the browser client must explicitly address application-parameter visibility, full-session scope, IndexedDB lifetime, remote revocation versus local logout, all three Telegram platforms, and same-origin script access. The published API docs currently load external Swagger JavaScript from a mutable major-version CDN URL on the Wiki origin; that code would share access to persistent Telegram-session IndexedDB if a full client were integrated on the same origin unchanged. Isolation or an appropriately reviewed self-hosted/pinned script policy must be settled before publishing such persistence. No production source change is made merely from the successful unauthenticated transport probe.

## Human-authorized local Telegram-session lifecycle proof

The user explicitly approved using only the existing project's API_ID/API_HASH for private local research, without its STRING_SESSION, another account's login, publication or production use. Only those two application parameters were supplied to the private local form; no values were printed, committed, bundled or deployed. After a human handoff, the user completed a separate Telegram login themselves.

The auth owner reports this verified local-browser sequence on 2026-10-20 (all timestamps UTC): first game auth/me200 at 20:18:27.924; repeat without another Telegram login at 20:19:07.858; browser reload plus application parameters restored the IndexedDB Telegram session without phone/code/QR and produced another game auth/me200 at 20:19:20.222. All me assertions were strict objects and only the new JWT was used. Remote auth.logOut completed, in-memory game JWT was cleared, and the client destroyed. A later restoration attempt at 20:19:38.216 required a phone login and reported disconnected. Telegram-session revocation is not claimed to revoke previously issued game JWTs on the game's server.

This supersedes earlier statements that no research user session had ever been created or that local lifecycle was untested. It proves the local browser prototype, not production cross-platform integration. The approved parameters remain LOCAL-ONLY.

The next candidate uses a separate connector origin with self-hosted JS/WASM, full-session IndexedDB confined to that origin, and a narrow exact-origin/source/correlated-message interface returning game JWT/status/logout outcomes to Wiki. No Telegram session export or arbitrary MTProto dispatch is permitted. Library fit review found default browser WebSocket transport and small local WASM binaries; production Worker must serve application/wasm and actual CSP headers. Nested Telegram Web iframe ancestors and phone/native storage behavior must be tested rather than inferred. Application-parameter delivery/exposure and actual production login remain gates before publication. Existing app code/deploy are unchanged; the separate two-origin candidate is still being prepared.

## Local two-origin candidate and integration review

A two-origin candidate now exists in the working tree: connector/ owns the isolated browser Telegram client and fixed game-auth relay; shared/telegram-connector.js owns the parent message bridge; TelegramConnection integrates with the existing LoginControl and shared Modal/Dialog components. API application parameters are not VITE build variables; the local connector reads a private runtime-only file. No production parameters, connector hosting project or auth deployment has been configured.

The auth owner reports the first real local Wiki iframe flow succeeded: the connection dialog closed, the existing profile UI appeared, and me200 used the newly issued game JWT without manual token copying. This remains local-browser proof, not native Telegram Desktop/phone production auth proof.

Coordinator reviewed the protocol/source/origin/nonce checks, fixed relay, single-flight exchange, shared UI changes and failure paths. Two issues were reproduced with in-memory mock clients and no real Telegram calls: a deferred getMe completed after logout and wrote a stale connected state; combined remote-logout and local-storage-cleanup failures incorrectly returned localCleared true. The auth owner is addressing these, late phone/QR grant cancellation, timeout cancellation, cross-tab logout, expected-account single-flight identity and retry/error completion before source freeze. No app-source edits or git-index mutations were made by coordinator.

Deployment read-only fit checks confirm separate Worker CSP headers, explicit application/wasm, five library WebSocket endpoints, and non-shared memory for both default crypto WASM binaries. No default-crypto requirement for COOP/COEP or SharedArrayBuffer was found. Nested iframe ancestor policy and all actual target clients still require end-to-end tests. Runtime app-parameter exposure remains a separate user decision because current credentials are approved for local research only.

## Review fixes and local automatic renewal

The actual Wiki iframe login produced profile UI and me200/strict object at 2026-10-20 20:29:25.890 UTC (23:29:25.890 Europe/Minsk), with auto-connect enabled and no manual game-token copying. After deleting only the local game JWT while retaining the approved Telegram session and auto flag, the background iframe obtained a different new JWT without another code or interaction in 1385ms; me200/strict object followed at 20:33:49.733 UTC (23:33:49.733 Europe/Minsk).

Coordinator independently reran the two earlier mock fixtures against the revised session code: a deferred getMe after logout no longer emitted connected, and simultaneous remote-revocation/storage-cleanup failures reported both remoteRevoked false and localCleared false. The owner reports ten focused tests covering late code/QR grants, cancellation, identity-bound single flight, bridge timeout cancellation, stale messages and cleanup failures. Broader checks and source freeze remain pending; these fixes are not yet a published production claim.

A hosted-release guard is required: the ignored local .env.local intentionally selects http://127.0.0.1:4199 for local testing and must never enter a public build. Final artifacts must be clean-built with the real approved HTTPS connector origin and identifiable main/connector source versions. API application parameters remain approved for local use only. Native/phone production login and a decision about public browser application parameters remain separate gates.

## Frozen local auth candidate reviewed

The owner froze the local two-origin candidate after a serial full-suite run of 62 tests passed, lint passed, main and connector builds passed, and Worker packaging passed. A concurrent test/Vite-cache shutdown problem did not reproduce in the serial suite; it is not used as proof of a production defect. Thirteen focused auth tests cover the reviewed control-plane scenarios. After the final wrong-account logout warning fix, lint and those thirteen tests passed again. Coordinator read the fix and approved the frozen local candidate's static integration; no other mandatory source finding remains from this review.

Live local Wiki logout at 2026-10-20 20:37:51.307 UTC (23:37:51.307 Europe/Minsk) confirmed remote revocation and local cleanup, removed profile UI in two tabs, and required consent/login on reopening. This complements the already proven fresh login and automatic renewal. Public deployment and native/phone auth are not inferred from local-browser proof.

Release packaging now reads built connection-config metadata, rejects enabled localhost/invalid origins, and can require a real HTTPS connector. A negative test actually rejected the current local main build. Connector release.json carries its service/source/protocol/Wiki origin; local packaged metadata correctly says sourceCommit local. Final publication must replace that with an exact pushed source SHA and the actual second Site identity/origin. Read-only Worker checks verified explicit WASM MIME, CSP on success/errors, no COOP/COEP, no source maps or API Hash literals, and no accidental Wiki project identity in the connector package.

Production remains gated on the user's decision about application parameters being visible to browser visitors, or a separate dedicated Telegram API application. Existing parameters are LOCAL-ONLY and have not been published. Safe source checkpoint and production credential configuration are separate actions; no production activation is claimed here.

## Production activation started after explicit approval

The frozen candidate passed static integration review after its final wrong-account logout warning fix. The user then explicitly approved public browser runtime use of the two application parameters. Coordinator released the registration/configuration/deployment hold to track B and safe source publication to track A; no parameter value is a publication input. Auth owner retains exclusive Telegram/browser UI and will arrange the public-origin human login handoff. Actual connector origin, source/deployment versions and production proof will be recorded after creation; no guessed domain is treated as live.

## Safe auth source checkpoint and connector hosting identity

Track A audited and pushed the frozen auth candidate as f625e9759d45b0de07fed97ea1152a9b3a62b396. Exactly the approved source/test/docs paths were included; application parameters, Telegram sessions, local .env/config files, builds and private artifacts were excluded. This push does not activate production: there is no automatic GitHub-to-Sites deployment. Existing live Wiki remains cdc92f24b3562b06d644546823cfcda499d4d1ea until an explicit new deployment succeeds.

Track B created the separate free connector project appgprj_6ad7d2c207c881918d41a93a70483788. Its authoritative expected origin is https://madhouse-connect.damir-tarasov2016.chatgpt.site, not yet public-release evidence. Public identity is stored in connector/.openai/hosting.json; the primary .openai/hosting.json is unchanged. Both manifests were independently checked by coordinator and contain no D1/R2 or runtime parameter values. Only the two approved application parameters may be configured in the connector provider environment, marked secret for tool/provider storage even though the browser runtime endpoint intentionally exposes them with permission. No Telegram session, STRING_SESSION or account state is a deployment input.

The final main build must explicitly select this actual HTTPS origin and require connector configuration. Both resources must be clean-built from the final pushed GitHub source. The connector provider checkout needs its own root hosting identity, so its provider-envelope commit can differ from the GitHub source commit; provenance must record both plus Worker artifact SHA. Public release markers identify the GitHub source, while provider version metadata identifies the actual pushed provider state. The primary Wiki provider checkout can retain the exact GitHub commit. Public login, renewal, logout and target-client proof follow deployment; no prepublication readiness claim is made.
