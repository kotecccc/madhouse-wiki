# GitHub publication status

Date: 2026-10-20 (Europe/Minsk). Track A active; repository created and verified, first source checkpoint prepared for push.

## Verified identity and repository

- Repository: [kotecccc/madhouse-wiki](https://github.com/kotecccc/madhouse-wiki), public, project title Madhouse Wiki. Created 2026-10-20 by coordinator through normal helper-backed GitHub API: verified owner `kotecccc`, lookup 404, create 201. Independent connector lookup confirms repository ID 1427474139, public visibility and admin/push permission.
- SSH origin configured: `git@github.com:kotecccc/madhouse-wiki.git`.
- GitHub connector authenticated login: `kotecccc` (ID 200638584). SSH authentication independently returned the same login.
- GitHub CLI is installed but unauthenticated. Connected GitHub tools support repository lookup and Git objects, but provide no repository creation action. Existing Git osxkeychain helper returns a credential; it was used only in process memory for normal GitHub API authentication, with no value output or copy. Requests failed before account validation; coordinator subsequently verified `/user` as `kotecccc` and created the empty repository.
- Chrome and Codex in-app browser both fail opening `https://github.com/new` with `ERR_CONNECTION_RESET`; Chrome reload fails too. Shell HTTPS to GitHub fails with a broken pipe. No credentials were exposed or network/security settings changed. Unauthenticated Python HTTPS reached the GitHub home page and API (200), but `/new` timed out and helper-backed `/user` requests failed with network errors; this is a route/client-specific access failure, not proof of a global GitHub outage.
- Existing Git root is `/Users/mac/projects/madhouse-wiki`, branch `main`, initial HEAD `f47a7ce073f28516b2fdf1995cb4d723422d5251`; no remotes configured at start.
- Existing history author is Тарасов Дамир with the established work email. New publication commits will use Тарасов Дамир and the personal email already configured in Frontend Punks. Existing history is preserved.

## Audit and publication scope

- Both existing commits audited: 151 unique blobs checked for JWTs, GitHub tokens, Telegram bot token formats and private key headers; no matches.
- Current src/scripts/shared/tests/docs/public/source-note files scanned (135 files at initial pass); no credential matches. This is a pattern scan, supplemented by review of publication paths.
- API contracts and Postman templates are documentation. Environment credential/user fields are empty, while catalogue values are reference-only.
- Publish application source, relevant scripts/tests, public API documentation and audited release documentation. Preserve intentional legacy JSON removals. Do not bulk-stage untracked artifacts, captures, environment files, private local SQLite or session files.
- Track B owns sanitized SQLite build input and ignore rules; await exact paths and clean-build readiness before checkpoint. Only Track A stages, commits and pushes.
- Additional historical scans found no concrete Bearer/Telegram initData/API hash/password literals. Three already-tracked refactor screenshots were inspected and contain only the public catalogue UI.
- No license is invented for third-party game assets.

## Next steps

1. Track B confirmed isolated build from seed passed and 3 proxy tests passed. Sanitized seed independently checked: 4,821 entities, 1,829 links, 500 provenance sources, 239 routing entries, empty source_documents and no credential-pattern rows.
2. Exact staged tree audited: 162 files, zero credential-pattern findings, no private SQLite, environment, session or dependency/build paths. Staged diff whitespace check passed. The single user-provided reference source note is explicitly included; other ignored artifacts remain local. Safe checkpoint will preserve the current authorized UI/catalogue migration and production build input.
3. Push to the verified public repository; creation blocker is resolved.
4. Wait for deployment/Telegram final-ready and coordinator integration decision, then audit and push final source.
5. Verify remote owner, branch and exact SHA. No push or deployment success is claimed yet.
