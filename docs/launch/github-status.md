# GitHub publication status

Date: 2026-10-20 (Europe/Minsk). Track A source publication complete; final evidence documentation prepared for push.

## Repository and authorship

- Public repository: [kotecccc/madhouse-wiki](https://github.com/kotecccc/madhouse-wiki), repository ID 1427474139. Title/description: Madhouse Wiki. GitHub default branch: `main`.
- Homepage: [Madhouse Wiki](https://madhouse-wiki.damir-tarasov2016.chatgpt.site/), updated and verified through GitHub API.
- Owner `kotecccc` confirmed independently by the connected GitHub account, SSH authentication, and normal Git credential-helper API authentication. Admin/push permissions verified.
- SSH origin: `git@github.com:kotecccc/madhouse-wiki.git`.
- New commits use the user's established personal identity: Тарасов Дамир <damir.tarasov2016@gmail.com>. Existing history and its original authorship remain intact.
- Existing dirty `main` was preserved and its authorized UI/catalogue migration published. No reset, stash, checkout, clean, force-push or history rewriting was performed. Only Track A mutated the Git index, commits and push; coordinator created the empty repository and updated its homepage after verified authentication.

## Published source

- Initial audited checkpoint: `86f488cff0f7b4f28c56187e75771a356173f551`.
- Hosting/Telegram source integration: `6364781e8da7e32bc1f641c7c15704a6b211955d`.
- Deployed source: [`cff5288b21dc08d7f059aa261a7422ead5f939b3`](https://github.com/kotecccc/madhouse-wiki/commit/cff5288b21dc08d7f059aa261a7422ead5f939b3). Intermediate narrowly scoped commits add safe proxy diagnostics; all were pushed without rewriting history.
- The final evidence commit changes documentation only. Its HEAD may differ from the deployed source SHA above; source runtime/catalogue assets are unchanged.

## Safety audit and build input

- Audited both original commits (151 unique blobs), current source/documentation, and exact staged trees for JWTs, GitHub/Telegram tokens, private-key headers and concrete launch credentials. No credential-pattern findings. Additional historical Bearer/API-hash/password checks were clear. Pattern scans were supplemented with path/content review.
- Three already-tracked refactor screenshots were visually inspected and contain only catalogue UI. Untracked artifact dumps were not bulk-added.
- No environment values, private canonical SQLite, session files, raw account captures, dependency/build directories, bot token or signed launch payloads were committed. Ignore rules protect these paths. Secret values stayed outside the repository or in process memory.
- API contracts and empty Postman credential templates remain public documentation. Legacy JSON catalogue removals are preserved. No license was invented for third-party game assets.
- Published `catalogue/reference.sqlite` is a newly generated reference-only seed: 4,821 entities, 1,829 links, 500 provenance rows, 239 route discoveries and 535 route/status/count/time coverage rows. Raw source_documents are empty; observations/private pages/free-form capture notes are excluded. Existing strict per-kind projections are reused. One audited user-provided reference-cost source note is explicitly included.
- Track B verified isolated clean builds without private local-data and rebuilt from the pushed GitHub source. Canonical local-data/madhouse.sqlite remains the local source of truth; clean builds restore the sanitized seed through the same SQL/Vite pipeline.

## Verification and limits

- SSH remote branch checks match pushed local SHAs; connected GitHub commit lookup independently confirmed publication.
- Track A independently fetched public `/release.json`: correct repository and exact source SHA `cff5288b21dc08d7f059aa261a7422ead5f939b3`.
- Track A independently requested public `/api/me` with a deliberately invalid non-secret token: HTTP 401, `Cache-Control: private, no-store, max-age=0` and CDN no-store headers. No real account credentials were used in this check.
- Coordinator validated final deployed source: 49 tests passed, 0 failed; lint/data/diff checks passed. Track B validated six final proxy cases and production smoke. Aggregate formatting has pre-existing warnings, so a full aggregate check is not claimed.
- Telegram bot exists and links to the live website; embedded Telegram rendering remains unverified. Fresh official-game login returned HTTP 401 twice, no token was issued, and successful authenticated production reads remain unverified. See `telegram-status.md`; no successful connector is claimed.
- Hosting deployment/version, public mobile/assets checks and provider constraints are recorded in `deploy-status.md`; overall release acceptance and outstanding external limits are recorded in `release-status.md`.
