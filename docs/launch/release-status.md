# Madhouse Wiki release status

Date: 2026-10-20 (Europe/Minsk). Overall status: in progress; release is not yet verified.

## Coordination and ownership

- Coordinator: `01a15ac6-b0b3-7132-b606-accd4a604f55`; integration evidence and this file.
- GitHub publication: `01a15ac6-2ce0-7633-9726-421e45045bb0`; exclusive git index, commit and push ownership; `github-status.md`.
- Deployment: `01a15ac6-777e-74c3-a65c-fb22ad25f1b7`; catalogue packaging, production transport and deployment; `deploy-status.md`.
- Telegram: `01a15ac6-79c9-7380-a665-810eaa1daf3c`; exclusive Telegram/BotFather and connection proof; `telegram-status.md`.

The coordinator goal is active. All tracks received cross-track IDs and the required release sequence. No additional agents were created. Existing dirty `main` is preserved; coordinator does not stage or commit.

## Evidence at start

- Workspace and Git root confirmed: `/Users/mac/projects/madhouse-wiki`.
- Branch: `main`; initial HEAD: `f47a7ce073f28516b2fdf1995cb4d723422d5251` (`feat: db`).
- Substantial authorized UI/catalogue changes and untracked source/tests are present. Historical JSON removals belong to the active SQLite migration and must not be restored automatically.
- Current build uses React/Vite with a canonical local SQLite catalogue. Production packaging and API transport require track B verification.

## Release acceptance

| Layer                    | Status                                            | Required evidence                                                                                                                           |
| ------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub                   | Safe checkpoint pushed; final integration pending | `https://github.com/kotecccc/madhouse-wiki`, public, owner `kotecccc`, branch `main`, checkpoint `86f488cff0f7b4f28c56187e75771a356173f551` |
| Reproducible catalogue   | Local clean build verified                        | Audited `catalogue/reference.sqlite`; isolated hosted build passed without private local-data                                               |
| Production website       | Pending                                           | Free public HTTPS URL, deployed SHA, assets/catalogue, mobile smoke test                                                                    |
| Production API transport | Pending                                           | Fixed upstream, bounded read-only routes, private/no-store behavior, observed public errors and authorized reads where available            |
| Telegram bot             | Created; live link pending                        | Track C created `https://t.me/MadhouseWikiBot`; website URL/configuration still pending                                                     |
| Game account connection  | Pending                                           | Fresh target-specific initData exchange without old Bearer, resulting token and read-only `/api/me`, or precise external blocker            |
| Final integration        | Pending                                           | Final audit, track A push, deployment of that SHA, public smoke test and verified bot URLs                                                  |

Push, deploy, bot setup and game login are distinct acceptance layers. No completion claim is made until supporting evidence is available. Secrets, raw account captures and session files must remain outside published source and status files.

## Integration checks and findings

- Baseline `npm test`: 39 passed, 0 failed (2026-10-20). The test runner reported existing HMR port 24678 contention; assertions still passed. This is local unit/render evidence, not public deployment proof.
- Coordinator `npm run lint` passed. `npm run validate:data` passed: SQLite integrity `ok`, zero unresolved links; includes 16 floor definitions and 108 bosses. These checks cover the current working tree while deployment integration is still ongoing.
- Integrated `npm test` after B/C source changes: 47 passed, 0 failed, including four shared production transport checks and four safe game-auth proof CLI checks. Existing HMR port contention remains a non-fatal test-run warning.
- Aggregate `npm run format:check` reports formatting issues in 12 pre-existing application/API/script/test files plus this evolving status file. Coordinator formats only its own status file; no unrelated UI/catalogue formatting changes are introduced. Lint, data validation and tests passed; full aggregate `check` is not claimed.
- Current login accepts a user-provided game JWT and stores it in browser localStorage. API responses use an in-memory session cache. A working manual JWT login does not establish Telegram-to-game connection.
- Track A confirmed GitHub owner `kotecccc` and working SSH authentication. Browser requests failed and gh CLI was unauthenticated. On Track A's explicit handoff, coordinator used the existing macOS Git credential helper in memory for normal GitHub API requests: `/user` returned 200 with `kotecccc`, target repository lookup returned 404, and repository creation returned 201. Public empty repository: `https://github.com/kotecccc/madhouse-wiki`, owner `kotecccc`, `private=false`. No secret was printed or persisted and no local Git metadata was changed by coordinator. Track A retains exclusive index/commit/push ownership.
- Track B is preparing a sanitized reference-only SQLite seed excluding raw source documents and observations. Public hosting URL is pending provider access.
- Track C detected that an existing unrelated project's MTProto session and active Telegram Desktop display different identities. It stopped mutations through that session; identity must be resolved before game authentication. Dedicated BotFather work stays with the authorized active Telegram surface.
- Track C reports creation of `@MadhouseWikiBot` on the authorized active Desktop account after checking owned bots for duplicates. Token storage is outside the repository with mode 600. Coordinator's separate public t.me HTTP check failed locally and does not independently verify bot functionality; BotFather/Bot API proof remains with track C.
- Coordinator network checks using Python urllib received HTTP 200 from GitHub, GitHub API, Vercel and Vercel API; `/new` routes are reachable too (GitHub redirects to login). Browser reset is narrower than a global service outage. GitHub/provider authenticated creation paths remain under investigation.
- Independent public GitHub API read confirms repository HTTP 200, `private=false`, owner `kotecccc`, default branch `main` (empty at the time of this check).
- Independent seed read confirms 4,821 entities, 1,829 links, 500 provenance sources, 535 coverage records and 239 discovered routes. Raw source documents are empty; SQLite integrity is `ok` and foreign-key check reports zero violations. Export creates a fresh database and reprojects entity payloads through reference allowlists.
- Track B reports isolated `build:hosted` passed without private local-data, with 106 modules; three targeted production-proxy tests passed. Vercel CLI currently rejects its token. Track B is checking legitimate login and the Sites hosting fallback with an isolated provider source repository.
- Safe source checkpoint pushed by Track A: `86f488cff0f7b4f28c56187e75771a356173f551`, `main`. Coordinator independently read the public GitHub commits API: HTTP 200 and the same SHA/message. Track A reports 162-file staged audit with zero credential findings and `git diff --check` passing. Final integration/deployment still pending.
- Sites fallback project is registered by Track B. Expected origin is not release evidence until published and checked. Vercel authentication is not yet available; no paid resource is authorized.
- Track C obtained fresh launch data through the official game in existing authorized Telegram Web. A clean POST without an old Bearer returned 401 (`telegram_auth_failed`), so no new game token or authenticated `/api/me` proof exists yet. Investigating the actual official client request; no connected success should be claimed.
- Track C source is ready: protected local proof CLI and four tests are integrated. Two distinct fresh launches returned clean 401; status of the official client's own authentication request could not be captured and remains unknown. The CLI is a diagnostic tool, not an end-user hosted connector. Temporary signed launch inputs were deleted; retained private proof contains sanitized status only.
