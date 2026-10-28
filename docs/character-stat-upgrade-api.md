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
- On 2026-10-27 the user authorized and requested single-point upgrades to the
  daily maximum. The following per-point prices were observed in the Wiki UI.
  The first aggression point had already been spent; its 150-gold price was
  obtained from the game's `startCost` field. All subsequent prices were
  observed immediately before their individual confirmed upgrades.

| Characteristic | Daily prices, in order                                                                                                                                                                                                                                                                                                                | Full daily total |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------: |
| Madness        | 500, 765, 1029, 1294, 1559, 1824, 2088, 2353, 2618, 2882, 3147, 3412, 3676, 3941, 4206, 4471, 4735, 5000 gold                                                                                                                                                                                                                         |      49,500 gold |
| Aggression     | 150, 173, 196, 219, 242, 264, 287, 310, 333, 356, 379, 402, 425, 447, 470, 493, 516, 539, 562, 585, 608, 631, 653, 676, 699, 722, 745, 768, 791, 814, 836, 859, 882, 905, 928, 951, 974, 997, 1019, 1042, 1065, 1088, 1111, 1134, 1157, 1180, 1203, 1225, 1248, 1271, 1294, 1317, 1340, 1363, 1386, 1408, 1431, 1454, 1477, 1500 gold |      49,500 gold |
| Rage           | 1,500 pills for each of 20 points                                                                                                                                                                                                                                                                                                     |     30,000 pills |

The 59 aggression points remaining after one upgrade total 49,350 gold.
These observations are client-visible game data, not a published API contract.
The implementation checks the current game quote and daily limits against the
schedule; mismatches use a conservative upper bound. MAX uses a fresh quote and a durable operation checkpoint before dispatch.

The server persists each requested single or multi-point upgrade as a priority
run. It waits for any in-flight game action to finish or be reconciled and checks
the confirmed quote again. New MAX runs submit the requested amount in one
checkpointed operation; previously saved per-point runs retain their original
execution mode. Multi-point server behavior and pricing have not yet been
verified with a live game mutation. While
this run is active, work, battle, business and raid workers retain their intent
and defer new mutations. They continue when the run finishes. An uncertain
character operation keeps other mutations paused until a read reconciles it;
neither the character operation nor an earlier uncertain action is replayed.
