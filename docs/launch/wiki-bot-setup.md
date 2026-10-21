# @madhouse_wiki_bot

## Implementation

- `api/telegram/bot-webhook` handles `/start`, `/help`, `/floors`, `/energy`, `/raids`, and inline queries.
- Inline queries return a combined business-unlock list, per-floor and per-department opening conditions, total energy formulas for work-based unlocks, and the latest public raid schedule.
- Floor and energy facts come from the canonical SQLite catalogue. Energy totals use only complete full-cycle costs and do not include a player's energy limit or recovery time. Raid cards read the public `/api/raids` feed. The bot does not store player progress or personal data.
- The Mini App keeps the existing Madhouse Wiki catalogue, calls `WebApp.ready()` after the React view is mounted, expands to the available height, applies the Wiki background to Telegram's header and uses a short branded loading screen.

## Telegram setup

The existing `@MadhouseWikiBot` username cannot be changed. Telegram treats bot usernames as immutable, so `@madhouse_wiki_bot` must be created as a separate bot in [@BotFather](https://t.me/BotFather). Do not reuse the existing bot token.

For the new bot:

1. Create `Madhouse Wiki` with username `madhouse_wiki_bot`.
2. Use `/setinline` and set the placeholder to `Этажи, энергия, рейды`.
3. In `/mybots` → `Madhouse Wiki` → `Bot Settings` → `Configure Mini App`, set the Main Mini App URL to `https://madhouse-wiki.vercel.app/`. This adds the profile's `Launch app` button. The setup command also configures the private-chat menu button.
4. In `Configure Mini App` → `Configure Splash Screen`, upload [`public/madhouse-wiki-splash.svg`](../../public/madhouse-wiki-splash.svg) (512×512) and set the light and dark loading backgrounds to `#191816`. This is Telegram's native loading placeholder; the React launch screen appears after the Mini App loads and calls `Telegram.WebApp.ready()`.
5. Optionally add a profile photo and Mini App preview media from the existing Wiki screens.

## Server configuration

Set these production environment variables on the Wiki Vercel project:

- `TELEGRAM_BOT_TOKEN` — token for `@madhouse_wiki_bot`.
- `TELEGRAM_BOT_WEBHOOK_SECRET` — 32–256 random characters from `A-Z`, `a-z`, `0-9`, `_`, `-`.
- `WIKI_PUBLIC_ORIGIN` — `https://madhouse-wiki.vercel.app`.
- `TELEGRAM_BOT_WEBHOOK_ORIGIN` — the HTTPS origin that serves the webhook; currently the Wiki production origin above.

The Wiki Vercel project already has a private Blob store connected through Vercel OIDC. The raid functions use that connection via `BLOB_STORE_ID`; they do not need a `BLOB_READ_WRITE_TOKEN`.

For local Bot API setup, keep the Telegram token, webhook secret, and the two origins in `~/.config/madhouse-wiki/madhouse-wiki-bot.env` with file mode `0600`. Profile, commands, and the private menu button can be configured before deployment without registering a broken webhook:

```sh
node --env-file=/Users/mac/.config/madhouse-wiki/madhouse-wiki-bot.env scripts/telegram/configure-wiki-bot.mjs --metadata-only
```

The full command checks the token's username and inline-mode flag, sets the same profile metadata, adds the `Открыть Wiki` menu button, and then registers the webhook with Telegram's secret-token header. Run it only after deploying and verifying the webhook route:

```sh
node --env-file=/Users/mac/.config/madhouse-wiki/madhouse-wiki-bot.env scripts/telegram/configure-wiki-bot.mjs
```

It verifies the webhook URL without printing the token or secret. The Main Mini App and its native splash screen still need the BotFather steps above.

`TELEGRAM_BOT_WEBHOOK_SECRET` protects the serverless webhook from unrelated requests. Keep both Telegram variables outside Git and do not include them in build logs.

## Sharing

In any group, enter one of:

- `@madhouse_wiki_bot этаж B`
- `@madhouse_wiki_bot энергия A`
- `@madhouse_wiki_bot рейды`

Choose a result to send it as a bot-authored message with a Wiki link. The raid result is read from the latest public schedule; if that feed is unavailable, the bot returns an unavailable card rather than stale schedule data.
