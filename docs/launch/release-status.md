# Madhouse Wiki release status

Date: 2026-10-20 (Europe/Minsk). Overall status: public reference site and bot launched; production GET transport forwards invalid-session responses correctly. Fresh game-account connection and embedded Telegram rendering remain unproven. Coordinator goal remains active for the unresolved connection scope.

## Public deliverables

- Website: [Madhouse Wiki](https://madhouse-wiki.damir-tarasov2016.chatgpt.site/).
- Repository: [kotecccc/madhouse-wiki](https://github.com/kotecccc/madhouse-wiki), public, branch `main`. Repository homepage points to the live website.
- Bot: [@MadhouseWikiBot](https://t.me/MadhouseWikiBot). Its WebApp menu, descriptions and BotFather domain point to the live website.
- Release marker: [release.json](https://madhouse-wiki.damir-tarasov2016.chatgpt.site/release.json).
- Independently verified pushed/deployed source: `cff5288b21dc08d7f059aa261a7422ead5f939b3`. Sites deployment: `appgdep_6ad7c32e35248191ac77bbba732ff356`. A later evidence-only documentation commit may advance repository HEAD; the deployed application is identified by its own source SHA.

## Acceptance by layer

| Layer                 | State                                               | Evidence and limits                                                                                                                                            |
| --------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub                | Verified                                            | Correct owner, public API/SSH pushed SHA checks, reviewed publication scope and established user authorship                                                    |
| Catalogue             | Verified                                            | Audited reference-only SQLite seed; isolated clean hosted build without private local-data                                                                     |
| Public website        | Verified                                            | HTTPS renders the actual React catalogue; assets, API docs and disclosure/drop modal work; mobile 390×844 checked                                              |
| Production API guards | Verified                                            | No-session me/dollar-floor 401; writes 405; unknown routes rejected; no-store responses                                                                        |
| Upstream forwarding   | Invalid-session forwarding verified                 | Controlled invalid Bearer now gets real upstream 401 with private/CDN no-store. No valid JWT was available for an authenticated read                           |
| Telegram bot          | Configured                                          | Bot API identity/menu/description getters, public profile and BotFather domain confirmation. Embedded catalogue rendering inside Telegram is not yet confirmed |
| Fresh game connection | Observed rejection                                  | Two fresh official-game launches produced clean 401 telegram_auth_failed without old Bearer; no new token or subsequent me proof; reason unknown               |
| Final integration     | Source/deployment verified; evidence commit pending | Clean exact-source deployment, public marker and smoke checks passed; final documentation push follows                                                         |

The Wiki bot is a website entry point. No persistent bot worker, conversational start handler, MTProto backend, automatic game connector or successful game login is claimed. Existing manual-JWT UI is preserved; its authenticated production behavior remains unverified.

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
- Telegram menu/destination is verified, but embedded rendering is unverified because accessibility and screenshot observations disagreed; this is not proof of a blank or incompatible site. Standalone responses have no CSP/X-Frame-Options blocking embedding.
- Coordinator CORS preflight to the fixed game API with the Wiki Origin returned 204 without Access-Control-Allow-Origin/Headers/Methods, so direct browser forwarding was not substituted.
- Track C obtained fresh official-game launch data through existing authorized Telegram Web. Two direct clean auth probes returned 401; the official client's own auth request was not captured. Protected local proof CLI is diagnostic only. No fabricated signature, developer-ID shortcut, gameplay write or new Telegram device session was used.

Public mobile screenshot: `artifacts/launch/production-mobile.png` (ignored local verification artifact).

## Security and coordination

Track A owns Git index/commits/pushes; B hosting/catalogue packaging/transport; C Telegram/BotFather/proof; coordinator this file and independent integration checks. Cross-chat messages are explicitly authorized by PLAN.md. No extra agents were created.

Workspace/root and initial dirty main were checked before work. Existing authorized UI/catalogue work was preserved and published after audit. No reset, stash, clean, checkout, force push or unrelated project changes. Initial HEAD was f47a7ce073f28516b2fdf1995cb4d723422d5251; first checkpoint 86f488cff0f7b4f28c56187e75771a356173f551.

GitHub creation used the existing macOS Git credential helper in memory after owner verification, without printing or persisting credentials. Publication audits found no credential material. Raw captures, private SQLite, environment/session files stay excluded. Bot secrets are outside the repository with restrictive permissions. Track C's status records handling of a temporary signed launch URL in a private tool result; it was never published/committed and must not be copied.

An unrelated project's MTProto session resolved to a different identity and was excluded from Wiki creation/game login; its temporary helper was removed. The authorized active Telegram account created/configured the bot. No paid plan, domain purchase, D1/R2 or persistent user-session service was provisioned. Vercel auth was unavailable; Sites supplied the provider subdomain.

See github-status.md, deploy-status.md and telegram-status.md for detailed evidence. Push, deployment, bot setup and game connection are separate claims.
