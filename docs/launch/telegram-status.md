# Telegram bot and game connection — Track C

Updated: 2026-10-20. Bot created, linked to the published website, and native Telegram Desktop catalogue rendering verified; fresh upstream game authentication rejected (HTTP 401).

## Verified bot

- Name: Madhouse Wiki.
- Handle: [@MadhouseWikiBot](https://t.me/MadhouseWikiBot).
- Created through BotFather in the existing Telegram Desktop account (display name Дамир Тарасов). `/mybots` showed six owned bots and no Wiki bot before creation; no duplicate was created.
- Bot API `getMe`: `ok=true`, username `MadhouseWikiBot`.
- `setMyDescription` and `setMyShortDescription`: `ok=true`; independent community reference wording, no claim of official affiliation.
- Configuration: [BotFather](https://t.me/BotFather), `/mybots` → @MadhouseWikiBot.
- Live site: [Madhouse Wiki](https://madhouse-wiki.damir-tarasov2016.chatgpt.site/).
- Bot API `setChatMenuButton`: `ok=true`; `getChatMenuButton` confirmed `type=web_app`, text `Открыть Wiki`, and the exact live-site URL above.
- Descriptions now include the public site URL; both setters and `getMyDescription`/`getMyShortDescription` confirmed success. The public `t.me/MadhouseWikiBot` page visibly shows the new short description and website address.
- BotFather `/setdomain` for `@MadhouseWikiBot` → `madhouse-wiki.damir-tarasov2016.chatgpt.site`: visible `Success! Domain updated.` This binds the Wiki bot's Login Widget domain; it does not provide game initData or implement a widget connection flow.
- Provider publication and actual React catalogue were independently verified by Track B/coordinator; `/release.json` identifies source commit `6364781e8da7e32bc1f641c7c15704a6b211955d`. Initial local Chrome/shell connection resets were transient; Python urllib also encountered provider filtering. They are not evidence of app authentication.
- Public screenshot, no secrets: `/Users/mac/.codex/visualizations/2026/10/20/01a15ac6-79c9-7380-a665-810eaa1daf3c/madhouse-wiki-bot.png`.
- Native Telegram Desktop embedded rendering is **verified**. In the existing authorized account, the Wiki bot's `Открыть Wiki` menu led to a Mini App Terms/Launch dialog. Execution stopped before accepting those terms. The user then explicitly confirmed the specific action and reported completing Launch themselves. A subsequent read-only check found the `Mini App: Madhouse Wiki` window already displaying the real React catalogue: Wiki header, `Войти`, all 16 floor selectors A through $, A1–A3 cards with energy values 90/199/260, and the `@MadhouseWikiBot` footer. No further Launch acceptance, game opening, auth probe or session access was performed for this verification.
- Native visual proof: `/Users/mac/.codex/visualizations/2026/10/20/01a15ac6-79c9-7380-a665-810eaa1daf3c/native-wiki-rendered.png`, mode `0600`, outside Git. The screenshot contains only the Mini App window, without other chats, launch URLs or credentials. Thumbnails appear blank in this capture; it proves embedded catalogue rendering, not successful loading of every image asset.
- The earlier Telegram Web accessibility `about:blank` versus screenshot mismatch remains historical observer evidence and is superseded by the direct native Desktop visual proof for embedded rendering. It did not establish site incompatibility. The Launch/Terms approval barrier has been resolved by the user's action; the distinct game-authentication HTTP 401 blocker remains unresolved.
- No webhook or continuously running bot worker is deployed. Opening the site uses the configured WebApp menu/public link; no conversational `/start` response is claimed.

## Secrets

- Bot token: `/Users/mac/.config/madhouse-wiki/bot-token`, file mode `0600`; parent directory `0700`. The value is never included here or in repository files.
- The temporary local MTProto inspection helper was removed after the identity mismatch was found. No Telegram user session was copied into this project.
- The existing Frontend Punks MTProto session is valid but resolves to a different account from the active Desktop user. It was used only for authorization identity inspection and BotFather `/mybots`, which returned no owned bots; it is not used to create the Wiki bot or authenticate to Madhouse. Frontend Punks files are unchanged.
- No new Telegram device session, login-code submission, password or 2FA action has been performed.

## Game connection proof

The official client and local OpenAPI documentation identify `POST https://cargohustle.online/api/auth/telegram` with `initData`, an `accessToken` response and `GET /api/me` for authenticated reads. A clean proof must send fresh target-specific initData without any previous Bearer token, then read `/api/me` with the resulting token. No successful exchange is claimed.

Observed controlled probes on 2026-10-20:

1. Opened the official `@imadhouse_bot` Mini App from its Play menu in the pre-existing authorized Chrome Telegram Web account matching the Desktop user. The observed iframe origin was `https://cargohustle.online`.
2. Read `tgWebAppData` from that observed iframe URL using `URLSearchParams` once, preserving the signed payload without editing it. Fresh `hash`, `signature` and `auth_date` were present.
3. Sent JSON `{initData}` to the fixed upstream auth endpoint without cookies or an old Authorization header: HTTP **401**, `error=telegram_auth_failed`.
4. Closed that app and launched again from the official chat's `Играть` button. The second initData differed from the first; its age was 28 seconds, raw literal `+` was absent. The same clean request again returned HTTP **401**, `telegram_auth_failed`. Adding the official Origin/Referer to the first request also did not change the rejection.
5. No access token was returned, so `/api/me` with a newly issued token was not attempted. The official client's own auth request/response was **not captured**: the browser's child-target network observer was unavailable. Its observed behavior must not be inferred from these direct probes.

Exact blocker: the game's upstream rejects fresh signed launch data from the official bot for this account. The reason (backend validation, accepted bot/launch method, or other server policy) is unconfirmed. A Wiki bot token cannot fix the game's validation, and a hosted user-session connector is not justified by this failed proof. Do not show a successful game connection.

Private sanitized evidence: `/Users/mac/.config/madhouse-wiki/game-auth-proof.json`, mode `0600`. Temporary initData files were deleted after the probes. A signed launch URL accidentally appeared in one internal accessibility tool result before URL filtering was applied; it is a login credential with unknown server TTL, was not published or committed, and must not be copied into status files or other chats. Bot token and game JWT were never printed.

Telegram's Mini App data validation is bot-specific; ordinary Wiki bot initData, Login Widget data or a deep link is not a game credential. A user Telegram API client can obtain the official game's launch data using its actual Mini App entry point. See [Telegram Mini Apps](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app) and [requestMainWebView](https://core.telegram.org/method/messages.requestMainWebView).

No fake signatures, developer-user-ID route, gameplay writes, upgrades, purchases or battles are used. Account responses and state must stay outside the canonical catalogue.

## Runtime boundary

A public Wiki bot and a functioning website do not establish a hosted game connector. A Telegram user-device session grants broad Telegram account access and must never be described as game-only authorization. Vercel static/serverless hosting does not by itself provide a persistent Telegram worker or durable local session store. Shared auth UI and deployment configuration remain owned by their respective tracks.

## Reproducible local proof tool

`node scripts/telegram/prove-game-auth.mjs /absolute/private/init-data-file`

Use only deliberately supplied fresh initData for the official game. The file must be outside the repository, readable only by its owner (`0600` or `0400`), and at most 32 KiB. The command performs one fixed-upstream login, then `/api/me` only if a token is returned. It uses no previous Bearer, follows no redirects, retries no requests, prints only allowlisted proof metadata, and keeps token/profile responses in memory without saving them. Login itself may initialize game state; no gameplay operations are performed. It does not obtain Telegram user access or make an end-user connection flow available.

Focused validation: `node --test scripts/telegram/prove-game-auth.test.mjs` — **4 tests passed** (clean auth header/body, subsequent token use, no personal/token output, rejection stopping before `/me`, no arbitrary error echo, invalid input preflight). Formatting and scoped `git diff --check` passed. Shared auth/frontend/deploy files were not changed by Track C.

## Final scope and limitations

Track C bot setup is complete. The automatic game-account connection is **not implemented or proven** because the upstream rejects fresh official launch credentials. A successful bot creation, domain binding, or menu opening is not game authentication. The proof CLI is a local diagnostic, not an end-user connector.

No valid existing game JWT was available in the authorized target-user context (the existing local Wiki visibly showed `Войти`). Therefore an authorized production `/api/me` call is also unverified. Production anonymous/invalid-token error behavior belongs to Track B and must be reported separately from a successful authenticated read.

Next useful action for game connection: obtain a supported backend authentication contract or capture a successful fresh official-client auth exchange with explicit authorization; determine why the server rejects its own bot's current launch data. Do not collect a broad Telegram user-device session or build a hosted connector until that foundation is proven. A manual valid JWT, if supplied by the user through the normal Wiki login, can independently verify the production GET transport.
