# Madhouse Wiki — GitHub, deployment and Telegram connection

Date: 2026-10-20. Owner: user. Status: execution authorized.

## Objective and authorization

Publish the existing Madhouse Wiki under the user's GitHub account, deploy a usable HTTPS site with a free provider subdomain, create a dedicated Telegram bot, and investigate and implement the supported parts of game-account connection. User explicitly authorizes GitHub creation/push/publication, deployment, BotFather operations and use of their existing Telegram account for this purpose. Do not incur paid charges or purchase a domain. Credentials must never appear in commits, browser screenshots, logs or chat messages. No cooperation from Madhouse developers can be assumed.

Every execution chat must call create_goal at its start, with its concrete objective and no invented token budget. Use GPT-6.1 Sol, reasoning medium, standard/default speed; do not enable Fast mode. Persistent chats are peers, not subagents. They may coordinate through send_message_to_thread as explicitly authorized by this plan and user request. Record actual status and non-secret evidence in separate files under docs/launch/. Do not mark goals complete while required work remains; report exact external blockers.

## Existing workspace and concurrency

Workspace: /Users/mac/projects/madhouse-wiki. Existing dirty main contains substantial authorized UI/catalogue work and may still be used by another UI chat. Preserve all existing changes; do not checkout, reset, clean, stash, force-push, rewrite history or silently overwrite concurrent edits. Before edits inspect AGENTS.md, git root/status and current file content. No worktree requested: use saved local project. Agent ownership below avoids index/build/source collisions.

Canonical catalogue is local-data/madhouse.sqlite, not legacy JSON. Build imports it via scripts/catalogue/query.mjs and a Vite virtual module. SQLite is currently ignored; a clean hosted build needs a deliberate reproducible, reference-only catalogue input. Do not publish account state, credentials, player inventory or session/access flags. Preserve data provenance and source wording. Existing public OpenAPI contracts are documentation, not secret payloads.

## Track A — GitHub publication

Own docs/launch/github-status.md, repository metadata/remote and final git staging/commit/push only. Do not edit deployment/auth source owned by other tracks.

1. Confirm current branch/history, gitignore and tracked/untracked scope. Resolve owner with existing gh authentication and Frontend Punks remote/config, without printing credential files, tokens or secrets. User requests GitHub, never GitLab.
2. Create repository madhouse-wiki (display name Madhouse Wiki) under the user's account. Public publication is authorized; preserve an existing matching repository instead of duplicating it. No license choice inventing rights for third-party assets.
3. Audit planned tracked files and git history for credentials/private data. Exclude .env, Telegram session/string-session files, JWTs, API credentials, raw personal captures, caches, node_modules and unrelated artifact dumps. Do not bulk add all untracked artifacts. Coordinate sanitized catalogue build input with deployment track before choosing files.
4. Initial checkpoint may publish a safe reviewable source snapshot; final release commit must include completed deployment/auth work and latest authorized UI changes only after other tracks report ready. Only this track mutates git index, commits and pushes. Other tracks request checkpoints via status/messages.
5. Check the remote repo and exact pushed commit. Record repository URL, branch, SHA, included source/data strategy and security audit outcome. Commit authorship must use user's established identity; never impersonate a guessed identity. Notify deploy and coordinator chats of repo URL and final SHA.

Acceptance: repository accessible at real GitHub URL, correct owner/authorship, reproducible sources present, no secrets, latest integration pushed. Push alone is not deployment proof.

## Track B — hosting and production readiness

Own deployment configuration, hosted /api proxy/transport, build catalogue packaging, docs/launch/deploy-status.md and deployment documentation. Coordinate before modifying shared auth/frontend files.

1. Inspect Vite build, SQLite virtual module, ignored catalogue dependencies and existing auth transport. A static-only deploy with Vite development proxy absent is incomplete if authenticated API requests fail.
2. Prefer Vercel with a free *.vercel.app URL if existing user authentication allows it. Check current official provider limits and available accounts/CLI; never silently create billable resources. If blocked choose an available free provider only after confirming functional fit; record why.
3. Provide a clean-build catalogue strategy using canonical SQLite or a sanitized reference-only SQLite seed, without recreating a legacy JSON catalogue. Verify clean isolated build input and preserve provenance. Catalogue data and source_documents must be audited before publication.
4. Implement required production GET API forwarding to the fixed Madhouse upstream, preserving current app auth behavior and endpoint scope. Avoid open proxies/SSRF, response/token logging, public personal caching, API writes and persisted account data. Never expose bot tokens, user sessions or server secrets via VITE_* variables.
5. Connect deployment to GitHub when available, with SPA routing/static assets/API docs working. For SQLite runtime writes or persistent MTProto, evaluate architecture honestly: Vercel functions do not establish durable local disk or a continuously running Telegram client. Site can launch independently while connector backend is separately deployed or explicitly blocked.
6. Verify build, targeted tests, public HTTPS URL, main page on mobile, actual catalogue rows/assets, API error behavior and authorized calls where available, no secrets in bundle. Record provider/project URL, deployment ID/SHA and remaining limitations. Coordinate final push/redeploy with Track A; do not mutate git index.

Acceptance: live free HTTPS URL, reproducible hosted build, correct catalogue, functional production transport for existing features; any unimplemented Telegram connector explicitly documented.

## Track C — Telegram bot and game connection proof

Own Telegram research, BotFather operations, connector/auth code in new dedicated paths, docs/launch/telegram-status.md and secret storage outside repo. Do not modify shared auth UI or deploy config without coordination.

1. Use the existing authorized Telegram surface/account, only for BotFather and the official Madhouse app. User authorizes sending necessary BotFather commands and creating/configuring this bot. Name: Madhouse Wiki. Preferred username: MadhouseWikiBot; if unavailable use MadhouseWikiGuideBot, then a minimally different recognizable Wiki username. Check existing owned matching bots before creating duplicates.
2. Use official Telegram docs. Bot API login/challenge/widget does not produce game initData. A user-authorized Telegram API/MTProto client can request opening the official game Mini App using the correct requestWebView/requestAppWebView/requestMainWebView method and obtain target-specific launch data. Do not manufacture signatures, use dev-userid paths or assume an arbitrary bot's initData works.
3. Store bot token/session secrets outside repository with restrictive permissions or approved provider secret storage. Do not print them, include them in screenshots, commit them, attach raw captures, put them in URLs shared with other chats, or save private messages/profile state in catalogue. Record only secret location and variable names.
4. Configure public bot description, start/menu link and domain once Track B provides HTTPS URL; avoid requesting unnecessary write permissions. Record exact username and configured URLs. Do not alter unrelated bots.
5. Inspect existing legitimate local MTProto integration patterns in Frontend Punks without modifying that project or exposing its credentials. Existing sessions may be used within user's authorization, with narrowly targeted calls only. A new Telegram device authorization must follow tool confirmation rules; user must take over for credential/password entry if required. Broad carte blanche does not override action-time security confirmation requirements. Do not bypass MFA/security warnings or send login codes into bot chats.
6. Perform one controlled proof, if a legitimate authorized session is available: obtain fresh initData for official Madhouse, explicitly enable the `MADHOUSE_ENABLE_LIVE_GAME_AUTH_PROOF=1` runtime gate, exchange via POST /api/auth/telegram without an old game Bearer confounding the result, inspect only status/token presence, then a read-only /api/me proof with resulting token. Keep raw credentials/identity private. Login may initialize game state: don't perform upgrades, purchases, battles or other game actions. Do not claim success until actual game token and authenticated read work.
7. If proof succeeds, propose and implement minimal explicit account-connect flow with clear distinction between Telegram user-device access and ordinary website login. Prefer local/session minimization; never label a full Telegram session as narrowly scoped game-only permission. Decide token/session lifetime, revocation, expiry and refresh based on observed contracts; no invented refresh endpoint. Coordinate hosting constraints with Track B.
8. If proof is blocked by missing session/interactive confirmation/provider limits, complete bot setup and all independent work, record exact blocker and next user action. A mock or widget login is not proof of Madhouse connection.

Acceptance: dedicated bot exists/configured, secrets protected, live exchange proven or concrete blocker documented, no misleading connected success UI.

## Coordinator and release sequence

1. Create these execution chats with requested model/reasoning; each starts its own goal. Coordinator also starts a goal, reads plan and monitors actual statuses.
2. Track A and B prepare independently; Track C creates bot/researches independently. Share only IDs, URLs, contract facts and status-file paths.
3. Coordinator maintains docs/launch/release-status.md and resolves file ownership/architecture conflicts. Can message each execution chat and request final integration; cannot report completion based only on delegated promises.
4. GitHub repo creation -> deployment connection -> verified public URL -> BotFather configuration. Target-specific initData proof is independent until a hosted end-user connector is required.
5. Final source audit -> final commit/push by Track A -> final deployment of that SHA -> public smoke test -> bot links verified -> goals completed only to extent all required deliverables achieved.
6. Report real URLs, repository owner/branch/SHA, bot handle, checks run, account-connection proof and any remaining user-required actions. Do not promise an hour guarantees completion and do not leave missing backend hidden behind a working static page.

## Explicit limits

No paid plans/domain purchase, no unrelated projects changes, no credential leaks, no destructive git operations. External service permission prompts, new account-wide sessions and non-recoverable actions still follow applicable action-time confirmation requirements. Continue independent tasks if one track is blocked. Preserve user-visible frontend progress from concurrent UI work.

## Created execution chats

See docs/launch/THREADS.md for the four real thread IDs and messaging fallback. These chats are already running: do not create duplicates. Release coordinator owns continued execution after this planning side chat returns.
