# Telegram bot and game connection — Track C

Updated: 2026-10-20. Execution ongoing; bot created, game-auth proof and hosted menu URL pending.

## Verified bot

- Name: Madhouse Wiki.
- Handle: [@MadhouseWikiBot](https://t.me/MadhouseWikiBot).
- Created through BotFather in the existing Telegram Desktop account (display name Дамир Тарасов). `/mybots` showed six owned bots and no Wiki bot before creation; no duplicate was created.
- Bot API `getMe`: `ok=true`, username `MadhouseWikiBot`.
- `setMyDescription` and `setMyShortDescription`: `ok=true`; independent community reference wording, no claim of official affiliation.
- Configuration: [BotFather](https://t.me/BotFather), `/mybots` → @MadhouseWikiBot.
- Menu/domain/live-site link: waiting for Track B's verified HTTPS URL.

## Secrets

- Bot token: `/Users/mac/.config/madhouse-wiki/bot-token`, file mode `0600`; parent directory `0700`. The value is never included here or in repository files.
- Local private operations helper: `/Users/mac/.config/madhouse-wiki/telegram-ops.cjs`, mode `0600`, outside repository. It references existing Frontend Punks credentials without copying or printing them.
- The existing Frontend Punks MTProto session is valid but resolves to a different account from the active Desktop user. It was used only for authorization identity inspection and BotFather `/mybots`, which returned no owned bots; it is not used to create the Wiki bot or authenticate to Madhouse. Frontend Punks files are unchanged.
- No new Telegram device session, login-code submission, password or 2FA action has been performed.

## Game connection proof

Pending. The official client and local OpenAPI documentation identify `POST https://cargohustle.online/api/auth/telegram` with `initData`, an `accessToken` response and `GET /api/me` for authenticated reads. A clean proof must send fresh target-specific initData without any previous Bearer token, then read `/api/me` with the resulting token. No successful exchange is claimed yet.

Telegram's Mini App data validation is bot-specific; ordinary Wiki bot initData, Login Widget data or a deep link is not a game credential. A user Telegram API client can obtain the official game's launch data using its actual Mini App entry point. See [Telegram Mini Apps](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app) and [requestMainWebView](https://core.telegram.org/method/messages.requestMainWebView).

No fake signatures, developer-user-ID route, gameplay writes, upgrades, purchases or battles are used. Account responses and state must stay outside the canonical catalogue.

## Runtime boundary

A public Wiki bot and a functioning website do not establish a hosted game connector. A Telegram user-device session grants broad Telegram account access and must never be described as game-only authorization. Vercel static/serverless hosting does not by itself provide a persistent Telegram worker or durable local session store. Shared auth UI and deployment configuration remain owned by their respective tracks.
