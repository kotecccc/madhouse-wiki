# Character-stat upgrade API evidence

The public game client `app.b3a2797399.js` and an authenticated read-only
`GET /api/me` were examined on 2026-10-27. The public client is evidence of
client behavior, not an independently published server contract.

- `GET /api/me` returns `characterStats.<stat>.base`, `wallet` and
  `characterStatsUpgrade`. Each of `madness`, `aggression` and `rage` includes
  `currency`, `costPerPoint`, `nextCost`, `startCost`, `maxCost`, `dailyLimit`,
  `dailyUsed`, and `dailyRemaining`. The enclosing object contains `resetAtUtc`.
- `POST /api/character-stats/upgrade` takes `{stat, amount, operationId}`. The
  client validates a positive amount, a known stat, and a UUID operation ID.
  The game UI normally sends one point at a time. The client uses
  `costPerPoint` for its single-point confirmation; it handles `characterStats`,
  `characterStatsUpgrade`, and `balance` from the response when provided.
- Client-recognized errors include `not_enough_currency`, `daily_limit_reached`,
  `rage_effect_cap_reached` and `rage_upgrade_exceeds_effect_cap`.
- The client retries some network failures with the same operation ID, but this
  is not independent proof of server idempotency. A lost response must be
  reconciled by a fresh read and never replayed automatically.
- The formula for the cost of multiple points and the meaning of `maxCost` as a
  bulk quote are not established. A multi-point workflow must use individually
  confirmed steps and enforce an explicit spending ceiling; it cannot multiply
  the current single-point price and present that as a guaranteed total.

Account-specific response bodies, tokens and identifiers are not recorded here.
