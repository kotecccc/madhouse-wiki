# Madhouse API discovery

Route discovery snapshot: 2026-10-20. Swagger and proxy coverage updated: 2026-10-24. The paths come from the public client bundle `app.b3a2797399.js`; the “observed” subset was also seen in Chrome DevTools Network while the Telegram Mini App loaded. This is a client-surface inventory, not a server-published OpenAPI contract. Endpoints can change without notice.

## Connection

- Base URL: `https://cargohustle.online`
- Authenticated requests use `Authorization: Bearer <accessToken>` and JSON requests use `Content-Type: application/json`.
- The client authenticates with `POST /api/auth/telegram`, body `{ "initData": "<Telegram WebApp initData>" }`. The client reads `accessToken` and `energy` from a successful response; do not save real values in this repository or Postman files.
- The Mini App launch fragment contains signed Telegram user data. It is deliberately excluded from this document. Keep `initData` and access tokens in process-local secret storage only.
- The client bundle also contains `/api/auth/dev-userid` with an `X-CargoHustle-Dev-Key` header. That is a development authentication path included for source completeness; it requires its own development key and is not a production authentication alternative.

Example read-only cURL call:

```sh
curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer ${MADHOUSE_API_TOKEN}" \
  --header "Accept: application/json" \
  "${MADHOUSE_API_BASE_URL:-https://cargohustle.online}/api/me"
```

The interactive Swagger UI at [`/api-docs/`](../public/api-docs/index.html) loads [`openapi.swagger.json`](../public/api-docs/openapi.swagger.json), which contains all 166 REST operations from the complete discovery specification in [`openapi.json`](../public/api-docs/openapi.json). The 62 GET operations keep their Russian reader descriptions; mutation descriptions and request schemas retain the source specification's client-derived wording. The UI uses the same-origin Wiki proxy. POST, PUT, PATCH, and DELETE are disabled until the page-only **Разрешить изменяющие запросы** checkbox is enabled. The API proxy independently requires `X-Madhouse-Allow-Mutations: true`, so direct calls remain disabled by default too. The toggle is not persisted.

Start the existing Vite app with `npm run dev` and open `http://127.0.0.1:4174/api-docs/`. Vite proxies documented game routes to the production host; the local proxy guard applies the same mutation-header requirement. The Wiki session supplies the Bearer token. Token persistence in Swagger is disabled. Russian GET operation text lives in [`api-readonly.ru.json`](api-readonly.ru.json). Regenerate both Swagger specifications with `node scripts/build-api-docs.mjs` after editing the text or the full specification.

The full Postman collection and environment remain in [`postman/`](postman/). Its own mutation guard defaults to `allowMutations=false`. Swagger uses a separate page-only toggle and a server-enforced request header.

## Initial requests observed in Network

This is the initial capture subset; the complete current capture coverage is in [`api-response-coverage.json`](api-response-coverage.json). These paths returned HTTP 200 in the loaded Mini App. Repeated requests are listed once. The parameter in `/api/bosses/{bossId}` replaces numeric IDs seen in the request log.

| Method | Path                                                 | Evidence                                  |
| ------ | ---------------------------------------------------- | ----------------------------------------- |
| POST   | `/api/auth/telegram`                                 | Network 200; client body field `initData` |
| GET    | `/api/me`                                            | Network 200                               |
| GET    | `/api/notifications`                                 | Network 200                               |
| GET    | `/api/bosses/invitations`                            | Network 200                               |
| GET    | `/api/bosses/{bossId}`                               | Network 200 for several IDs               |
| GET    | `/api/clans/me`                                      | Network 200                               |
| GET    | `/api/friends`                                       | Network 200                               |
| GET    | `/api/friends/requests/incoming`                     | Network 200                               |
| GET    | `/api/friends/requests/outgoing`                     | Network 200                               |
| GET    | `/api/player-interactions/booster-requests/incoming` | Network 200                               |
| GET    | `/api/player-interactions/booster-requests/outgoing` | Network 200                               |
| GET    | `/api/stash/sets`                                    | Network 200                               |

## Client route inventory

The following route bases and operations are present in the downloaded client bundle. The preceding Network section identifies the subset actually observed. Dynamic routes are normalized in the method table below; this list does not imply that every route is available to every account. The OpenAPI specification additionally records source-derived nested floor and business detail/leaderboard routes.

### Authentication, profile, and player

`/api/auth/telegram`, `/api/auth/dev-userid` (development), `/api/me`, `/api/me/offer/accept`, `/api/me/bag`, `/api/me/bag/boosters/buy`, `/api/me/bag/boosters/use`, `/api/me/bag/combat-items/buy`, `/api/me/energy/spend`, `/api/me/nickname`, `/api/me/settings`, `/api/player/customization`, `/api/player/customization/options`, `/api/character-stats/upgrade`, `/api/hubs/game`.

### Floors, work, businesses, and bosses

`/api/floors`, `/api/works/open`, `/api/works/tasks/perform`, `/api/businesses`, `/api/businesses/collect-all`, `/api/bosses`, `/api/bosses/{bossId}`, `/api/bosses/invitations`, `/api/bosses/statistics`.

### Combat and rewards

`/api/leaderboard/damage`, `/api/leaderboard/achievements`, `/api/leaderboard/combat`, `/api/leaderboard/experience`, `/api/leaderboard/clans`, `/api/combat`, `/api/combat/candidates/refresh`, `/api/combat/energy/refill`, `/api/combat/battles`, `/api/combat/battles/direct`, `/api/daily-rewards/state`, `/api/daily-rewards/claim`, `/api/quests`, `/api/achievements`.

### Leaderboards and mini-games

`/api/leaderboard/damage`, `/api/leaderboard/achievements`, `/api/leaderboard/combat`, `/api/leaderboard/experience`, `/api/leaderboard/clans`, `/api/mini-game/cards`, `/api/dice-game`, `/api/dice-game/start`, `/api/poker-game`, `/api/poker-game/start`, `/api/poker-game/chips/purchase`, `/api/bank/packages`, `/api/bank/purchases`.

### Stash and mutagens

`/api/stash/sets`, `/api/stash/help-requests`, `/api/stash/help-gifts`, `/api/stash/craft`, `/api/stash/ingredients/purchase`, `/api/mutagens/state`, `/api/mutagens/craft`, `/api/mutagens/exchange/state`, `/api/mutagens/exchange`, `/api/mutagens/chests/state`, `/api/mutagens/chests/slots/unlock`, `/api/mutagens/chests/openings/start`, `/api/mutagens/chests/openings/speedup`, `/api/mutagens/chests/openings/claim`.

### Equipment and customization

`/api/weapons`, `/api/weapons/buy`, `/api/weapons/select`, `/api/weapons/upgrade`, `/api/weapons/repair`, `/api/clothing`, `/api/clothing/sets`, `/api/clothing/by-category`, `/api/clothing/items/buy`, `/api/clothing/equip`, `/api/clothing/items/mutagens/available`, `/api/clothing/items/mutagens/installed`, `/api/clothing/items/mutagens/install`, `/api/clothing/items/mutagens/extract`, `/api/ornaments/zones`, `/api/ornaments/sets`, `/api/ornaments/elements/buy`, `/api/ornaments/equip`, `/api/rooms`, `/api/rooms/buy`, `/api/rooms/select`, `/api/pets`, `/api/pets/buy`, `/api/pets/select`, `/api/pets/upgrade`.

### Friends, clans, and notifications

`/api/friends`, `/api/friends/requests`, `/api/friends/requests/incoming`, `/api/friends/requests/outgoing`, `/api/friends/search`, `/api/friends/search/suggestions`, `/api/players`, `/api/player-interactions/booster-requests`, `/api/player-interactions/booster-requests/incoming`, `/api/player-interactions/booster-requests/outgoing`, `/api/player-interactions/booster-gifts`, `/api/player-interactions/booster-gifts/incoming`, `/api/player-interactions/pill-gifts`, `/api/player-interactions/pill-gifts/today`, `/api/player-interactions/pill-gift-campaigns`, `/api/player-interactions/pill-gift-campaigns/all-friends`, `/api/clans`, `/api/clans/me`, `/api/clans/invitations`, `/api/clans/rating`, `/api/clans/search`, `/api/notifications`, `/api/notifications/settings`, `/api/notifications/read`, `/api/notifications/non-actionable`, `/api/partner-campaigns/hooligans/confirm`.

## HTTP methods resolved from client callsites

The table is synchronized with OpenAPI. `?` marks optional query/body fields in the client contract. Request constraints and required fields derive from the client serialization/validators unless a separate wire capture is named. Captured response status is shown independently; it does not establish request-field enforcement by the server. Dynamic path values remain parameters.

| Method   | Path                                                            | Query                                 | JSON body fields                                    | Evidence                           |
| -------- | --------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------- | ---------------------------------- |
| `GET`    | `/api/achievements`                                             | —                                     | —                                                   | Captured 200                       |
| `GET`    | `/api/achievements/{category}`                                  | —                                     | —                                                   | Captured 200                       |
| `POST`   | `/api/auth/dev-userid`                                          | —                                     | userId, username, firstName, photoUrl               | Client callsite; request validator |
| `POST`   | `/api/auth/telegram`                                            | —                                     | initData                                            | Captured 200; request validator    |
| `GET`    | `/api/bank/packages`                                            | —                                     | —                                                   | Captured 200                       |
| `POST`   | `/api/bank/purchases`                                           | —                                     | packageId                                           | Client callsite; request validator |
| `GET`    | `/api/bosses/battles/{battleId}`                                | —                                     | —                                                   | Captured 200                       |
| `POST`   | `/api/bosses/battles/{battleId}/attack`                         | —                                     | operationId                                         | Client callsite; request validator |
| `POST`   | `/api/bosses/battles/{battleId}/invitations`                    | —                                     | playerId, operationId                               | Client callsite; request validator |
| `POST`   | `/api/bosses/battles/{battleId}/invitations/bulk`               | —                                     | operationId, playerIds?, onlyAvailable, onlyOnline  | Client callsite; request validator |
| `POST`   | `/api/bosses/battles/{battleId}/items/use`                      | —                                     | type, operationId                                   | Client callsite; request validator |
| `POST`   | `/api/bosses/battles/{battleId}/surrender`                      | —                                     | operationId                                         | Client callsite; request validator |
| `GET`    | `/api/bosses/invitations`                                       | direction, status                     | —                                                   | Captured 200                       |
| `POST`   | `/api/bosses/invitations/{invitationId}/accept`                 | —                                     | operationId                                         | Client callsite; request validator |
| `POST`   | `/api/bosses/invitations/{invitationId}/decline`                | —                                     | operationId                                         | Client callsite; request validator |
| `GET`    | `/api/bosses/statistics`                                        | —                                     | —                                                   | Captured 200                       |
| `GET`    | `/api/bosses/{bossId}`                                          | —                                     | —                                                   | Captured 200                       |
| `POST`   | `/api/bosses/{bossId}/battles`                                  | —                                     | operationId                                         | Client callsite; request validator |
| `POST`   | `/api/businesses/collect-all`                                   | —                                     | operationId                                         | Client callsite; request validator |
| `GET`    | `/api/businesses/{businessId}`                                  | —                                     | —                                                   | Client callsite                    |
| `POST`   | `/api/businesses/{businessId}/collect`                          | —                                     | operationId                                         | Client callsite; request validator |
| `POST`   | `/api/businesses/{businessId}/upgrade`                          | —                                     | operationId                                         | Client callsite; request validator |
| `POST`   | `/api/character-stats/upgrade`                                  | —                                     | stat, amount, operationId                           | Client callsite; request validator |
| `POST`   | `/api/clans`                                                    | —                                     | operationId, name, tag, joinType, emblem, minLevel? | Client callsite; request validator |
| `POST`   | `/api/clans/invitations/{invitationId}/accept`                  | —                                     | operationId                                         | Client callsite; request validator |
| `POST`   | `/api/clans/invitations/{invitationId}/decline`                 | —                                     | operationId                                         | Client callsite; request validator |
| `GET`    | `/api/clans/me`                                                 | —                                     | —                                                   | Captured 200                       |
| `GET`    | `/api/clans/rating`                                             | page, limit                           | —                                                   | Client callsite                    |
| `GET`    | `/api/clans/search`                                             | query                                 | —                                                   | Captured 400                       |
| `GET`    | `/api/clans/{clanId}/applications`                              | limit, cursor?                        | —                                                   | Client callsite                    |
| `POST`   | `/api/clans/{clanId}/applications/cancel`                       | —                                     | {}                                                  | Client callsite; request validator |
| `POST`   | `/api/clans/{clanId}/applications/{applicationId}/accept`       | —                                     | operationId, version?                               | Client callsite; request validator |
| `POST`   | `/api/clans/{clanId}/applications/{applicationId}/reject`       | —                                     | operationId, version?                               | Client callsite; request validator |
| `PUT`    | `/api/clans/{clanId}/daily-message`                             | —                                     | message                                             | Client callsite; request validator |
| `POST`   | `/api/clans/{clanId}/disband`                                   | —                                     | operationId, version                                | Client callsite; request validator |
| `GET`    | `/api/clans/{clanId}/events`                                    | day?, cursor?, limit?                 | —                                                   | Captured 200                       |
| `POST`   | `/api/clans/{clanId}/invitations`                               | —                                     | playerId                                            | Client callsite; request validator |
| `POST`   | `/api/clans/{clanId}/join`                                      | —                                     | operationId, message?                               | Client callsite; request validator |
| `POST`   | `/api/clans/{clanId}/leader/transfer`                           | —                                     | playerId, operationId, version                      | Client callsite; request validator |
| `POST`   | `/api/clans/{clanId}/leave`                                     | —                                     | operationId                                         | Client callsite; request validator |
| `GET`    | `/api/clans/{clanId}/members`                                   | limit, cursor?                        | —                                                   | Captured 200                       |
| `POST`   | `/api/clans/{clanId}/members/{playerId}/kick`                   | —                                     | version?                                            | Client callsite; request validator |
| `PUT`    | `/api/clans/{clanId}/members/{playerId}/role`                   | —                                     | role, version                                       | Client callsite; request validator |
| `PUT`    | `/api/clans/{clanId}/permissions`                               | —                                     | version, roles                                      | Client callsite; request validator |
| `PUT`    | `/api/clans/{clanId}/settings`                                  | —                                     | version, joinType?, minLevel?, tag?, emblem?        | Client callsite; request validator |
| `GET`    | `/api/clothing`                                                 | —                                     | —                                                   | Captured 200                       |
| `GET`    | `/api/clothing/by-category/{id}`                                | —                                     | —                                                   | Captured 200                       |
| `POST`   | `/api/clothing/equip`                                           | —                                     | itemId                                              | Client callsite; request validator |
| `DELETE` | `/api/clothing/equip/{id}`                                      | —                                     | —                                                   | Client callsite                    |
| `POST`   | `/api/clothing/items/buy`                                       | —                                     | itemId, operationId                                 | Client callsite; request validator |
| `GET`    | `/api/clothing/items/mutagens/available`                        | —                                     | —                                                   | Captured 200                       |
| `POST`   | `/api/clothing/items/mutagens/extract`                          | —                                     | categoryId, itemId                                  | Client callsite; request validator |
| `POST`   | `/api/clothing/items/mutagens/install`                          | —                                     | mutagenId, categoryId, itemId                       | Client callsite; request validator |
| `GET`    | `/api/clothing/items/mutagens/installed`                        | —                                     | —                                                   | Captured 200                       |
| `GET`    | `/api/clothing/sets/{id}`                                       | —                                     | —                                                   | Client callsite                    |
| `GET`    | `/api/combat`                                                   | —                                     | —                                                   | Captured 200                       |
| `POST`   | `/api/combat/battles`                                           | —                                     | candidateId, operationId                            | Client callsite; request validator |
| `POST`   | `/api/combat/battles/direct`                                    | —                                     | targetPlayerId, operationId                         | Client callsite; request validator |
| `GET`    | `/api/combat/battles/{battleId}`                                | —                                     | —                                                   | Captured 404                       |
| `POST`   | `/api/combat/battles/{battleId}/attack`                         | —                                     | operationId                                         | Client callsite; request validator |
| `POST`   | `/api/combat/battles/{battleId}/items/use`                      | —                                     | type, operationId                                   | Client callsite; request validator |
| `POST`   | `/api/combat/candidates/refresh`                                | —                                     | —                                                   | Client callsite                    |
| `POST`   | `/api/combat/energy/refill`                                     | —                                     | operationId                                         | Client callsite; request validator |
| `POST`   | `/api/daily-rewards/claim`                                      | —                                     | operationId                                         | Client callsite; request validator |
| `GET`    | `/api/daily-rewards/state`                                      | —                                     | —                                                   | Client callsite                    |
| `GET`    | `/api/dice-game`                                                | —                                     | —                                                   | Captured 200                       |
| `POST`   | `/api/dice-game/start`                                          | —                                     | operationId                                         | Client callsite; request validator |
| `POST`   | `/api/dice-game/{gameId}/collect`                               | —                                     | operationId                                         | Client callsite; request validator |
| `POST`   | `/api/dice-game/{gameId}/reroll`                                | —                                     | position, operationId                               | Client callsite; request validator |
| `GET`    | `/api/floors`                                                   | —                                     | —                                                   | Captured 200                       |
| `GET`    | `/api/floors/{code}/info`                                       | —                                     | —                                                   | Captured 200                       |
| `GET`    | `/api/floors/{code}/leaderboard`                                | —                                     | —                                                   | Client callsite                    |
| `POST`   | `/api/floors/{floorCode}/tribute/collect`                       | —                                     | operationId                                         | Client callsite; request validator |
| `GET`    | `/api/friends`                                                  | limit, cursor?                        | —                                                   | Captured 200                       |
| `POST`   | `/api/friends/requests`                                         | —                                     | playerId                                            | Client callsite; request validator |
| `GET`    | `/api/friends/requests/incoming`                                | limit, cursor?                        | —                                                   | Captured 200                       |
| `GET`    | `/api/friends/requests/outgoing`                                | limit, cursor?                        | —                                                   | Captured 200                       |
| `DELETE` | `/api/friends/requests/{playerId}`                              | —                                     | —                                                   | Client callsite                    |
| `POST`   | `/api/friends/requests/{playerId}/accept`                       | —                                     | {}                                                  | Client callsite; request validator |
| `GET`    | `/api/friends/search`                                           | query                                 | —                                                   | Client callsite                    |
| `GET`    | `/api/friends/search/suggestions`                               | prefix, limit, cursor?                | —                                                   | Client callsite                    |
| `DELETE` | `/api/friends/{playerId}`                                       | —                                     | —                                                   | Client callsite                    |
| `POST`   | `/api/hubs/game/negotiate`                                      | negotiateVersion                      | —                                                   | Client callsite                    |
| `GET`    | `/api/leaderboard/achievements`                                 | —                                     | —                                                   | Captured 200                       |
| `GET`    | `/api/leaderboard/clans`                                        | —                                     | —                                                   | Captured 200                       |
| `GET`    | `/api/leaderboard/combat`                                       | —                                     | —                                                   | Captured 200                       |
| `GET`    | `/api/leaderboard/damage`                                       | —                                     | —                                                   | Captured 200                       |
| `GET`    | `/api/leaderboard/experience`                                   | —                                     | —                                                   | Captured 200                       |
| `GET`    | `/api/me`                                                       | —                                     | —                                                   | Captured 200                       |
| `GET`    | `/api/me/bag`                                                   | —                                     | —                                                   | Captured 200                       |
| `POST`   | `/api/me/bag/boosters/buy`                                      | —                                     | type, quantity, operationId                         | Client callsite; request validator |
| `POST`   | `/api/me/bag/boosters/use`                                      | —                                     | type                                                | Client callsite; request validator |
| `POST`   | `/api/me/bag/combat-items/buy`                                  | —                                     | type, currency, quantity, operationId               | Client callsite; request validator |
| `POST`   | `/api/me/energy/spend`                                          | —                                     | amount?                                             | Client callsite; request validator |
| `PUT`    | `/api/me/nickname`                                              | —                                     | nickname                                            | Client callsite; request validator |
| `POST`   | `/api/me/offer/accept`                                          | —                                     | —                                                   | Client callsite                    |
| `PUT`    | `/api/me/settings`                                              | —                                     | musicEnabled, sfxEnabled                            | Client callsite; request validator |
| `POST`   | `/api/mini-game/cards/{cardId}/cancel`                          | —                                     | operationId                                         | Client callsite; request validator |
| `POST`   | `/api/mini-game/cards/{cardId}/try`                             | —                                     | operationId                                         | Client callsite; request validator |
| `POST`   | `/api/mutagens/chests/openings/claim`                           | —                                     | type, operationId                                   | Client callsite; request validator |
| `POST`   | `/api/mutagens/chests/openings/speedup`                         | —                                     | type, operationId                                   | Client callsite; request validator |
| `POST`   | `/api/mutagens/chests/openings/start`                           | —                                     | type, operationId                                   | Client callsite; request validator |
| `POST`   | `/api/mutagens/chests/slots/unlock`                             | —                                     | type, operationId                                   | Client callsite; request validator |
| `GET`    | `/api/mutagens/chests/state`                                    | —                                     | —                                                   | Captured 200                       |
| `POST`   | `/api/mutagens/craft`                                           | —                                     | recipeId, craftCount, operationId                   | Client callsite; request validator |
| `POST`   | `/api/mutagens/exchange`                                        | —                                     | recipeId, exchangeCount, operationId                | Client callsite; request validator |
| `GET`    | `/api/mutagens/exchange/state`                                  | type, level?                          | —                                                   | Captured 200                       |
| `GET`    | `/api/mutagens/state`                                           | type                                  | —                                                   | Captured 200                       |
| `GET`    | `/api/notifications`                                            | limit, unreadOnly, cursor?, category? | —                                                   | Captured 200                       |
| `DELETE` | `/api/notifications/non-actionable`                             | —                                     | —                                                   | Client callsite                    |
| `POST`   | `/api/notifications/read`                                       | —                                     | notificationIds                                     | Captured 200; request validator    |
| `GET`    | `/api/notifications/settings`                                   | —                                     | —                                                   | Captured 200                       |
| `PUT`    | `/api/notifications/settings`                                   | —                                     | options                                             | Client callsite; request validator |
| `POST`   | `/api/ornaments/elements/buy`                                   | —                                     | elementId, operationId                              | Client callsite; request validator |
| `POST`   | `/api/ornaments/equip`                                          | —                                     | elementId                                           | Client callsite; request validator |
| `DELETE` | `/api/ornaments/equip/{id}`                                     | —                                     | —                                                   | Client callsite                    |
| `GET`    | `/api/ornaments/sets/{id}`                                      | —                                     | —                                                   | Client callsite                    |
| `GET`    | `/api/ornaments/sets/{id}/zones`                                | —                                     | —                                                   | Client callsite                    |
| `GET`    | `/api/ornaments/zones/{id}`                                     | —                                     | —                                                   | Captured 200                       |
| `POST`   | `/api/partner-campaigns/hooligans/confirm`                      | —                                     | startParam                                          | Client callsite; request validator |
| `POST`   | `/api/pets/buy`                                                 | —                                     | petId, operationId                                  | Client callsite; request validator |
| `DELETE` | `/api/pets/select`                                              | —                                     | —                                                   | Client callsite                    |
| `PUT`    | `/api/pets/select`                                              | —                                     | petId                                               | Client callsite; request validator |
| `POST`   | `/api/pets/upgrade`                                             | —                                     | petId, currency, operationId                        | Client callsite; request validator |
| `GET`    | `/api/pets/{id}`                                                | —                                     | —                                                   | Captured 200                       |
| `GET`    | `/api/player-interactions/booster-gifts/incoming`               | —                                     | —                                                   | Captured 200                       |
| `POST`   | `/api/player-interactions/booster-gifts/{giftId}/claim`         | —                                     | operationId                                         | Client callsite; request validator |
| `POST`   | `/api/player-interactions/booster-requests`                     | —                                     | targetPlayerId, operationId                         | Client callsite; request validator |
| `GET`    | `/api/player-interactions/booster-requests/incoming`            | limit                                 | —                                                   | Captured 200                       |
| `GET`    | `/api/player-interactions/booster-requests/outgoing`            | limit                                 | —                                                   | Captured 200                       |
| `POST`   | `/api/player-interactions/booster-requests/{requestId}/fulfill` | —                                     | operationId                                         | Client callsite; request validator |
| `POST`   | `/api/player-interactions/pill-gift-campaigns/all-friends`      | —                                     | operationId                                         | Client callsite; request validator |
| `GET`    | `/api/player-interactions/pill-gift-campaigns/{campaignId}`     | —                                     | —                                                   | Client callsite                    |
| `POST`   | `/api/player-interactions/pill-gifts`                           | —                                     | recipientPlayerIds, operationId                     | Client callsite; request validator |
| `GET`    | `/api/player-interactions/pill-gifts/today`                     | —                                     | —                                                   | Captured 200                       |
| `PUT`    | `/api/player/customization`                                     | —                                     | faceId, hairstyleId, hairColorId                    | Client callsite; request validator |
| `GET`    | `/api/player/customization/options`                             | —                                     | —                                                   | Captured 200                       |
| `GET`    | `/api/players/{playerId}`                                       | —                                     | —                                                   | Client callsite                    |
| `GET`    | `/api/players/{playerId}/achievements`                          | —                                     | —                                                   | Client callsite                    |
| `GET`    | `/api/players/{playerId}/bosses/statistics`                     | —                                     | —                                                   | Client callsite                    |
| `GET`    | `/api/poker-game`                                               | —                                     | —                                                   | Captured 200                       |
| `POST`   | `/api/poker-game/chips/purchase`                                | —                                     | quantity, operationId                               | Client callsite; request validator |
| `POST`   | `/api/poker-game/start`                                         | —                                     | operationId                                         | Client callsite; request validator |
| `POST`   | `/api/poker-game/{gameId}/collect`                              | —                                     | operationId                                         | Client callsite; request validator |
| `POST`   | `/api/poker-game/{gameId}/exchange`                             | —                                     | position, operationId                               | Client callsite; request validator |
| `POST`   | `/api/poker-game/{gameId}/showdown`                             | —                                     | operationId                                         | Client callsite; request validator |
| `GET`    | `/api/quests/{section}`                                         | —                                     | —                                                   | Captured 200                       |
| `POST`   | `/api/quests/{section}/{taskId}/claim`                          | —                                     | operationId                                         | Client callsite; request validator |
| `GET`    | `/api/rooms`                                                    | —                                     | —                                                   | Captured 200                       |
| `POST`   | `/api/rooms/buy`                                                | —                                     | roomId, operationId                                 | Client callsite; request validator |
| `PUT`    | `/api/rooms/select`                                             | —                                     | roomId                                              | Client callsite; request validator |
| `POST`   | `/api/stash/craft`                                              | —                                     | setId, operationId                                  | Client callsite; request validator |
| `POST`   | `/api/stash/help-gifts`                                         | —                                     | targetPlayerId, items, operationId                  | Client callsite; request validator |
| `POST`   | `/api/stash/help-requests`                                      | —                                     | setId, ingredientId                                 | Client callsite; request validator |
| `DELETE` | `/api/stash/help-requests/{setId}/{ingredientId}`               | —                                     | —                                                   | Client callsite                    |
| `GET`    | `/api/stash/help-requests/{targetPlayerId}`                     | —                                     | —                                                   | Client callsite                    |
| `POST`   | `/api/stash/ingredients/purchase`                               | —                                     | setId, ingredientId, operationId                    | Client callsite; request validator |
| `GET`    | `/api/stash/sets`                                               | —                                     | —                                                   | Captured 200                       |
| `POST`   | `/api/weapons/buy`                                              | —                                     | weaponId, operationId                               | Client callsite; request validator |
| `POST`   | `/api/weapons/repair`                                           | —                                     | weaponId, operationId                               | Client callsite; request validator |
| `DELETE` | `/api/weapons/select`                                           | —                                     | —                                                   | Client callsite                    |
| `PUT`    | `/api/weapons/select`                                           | —                                     | weaponId                                            | Client callsite; request validator |
| `POST`   | `/api/weapons/upgrade`                                          | —                                     | weaponId, currency, operationId                     | Client callsite; request validator |
| `GET`    | `/api/weapons/{id}`                                             | —                                     | —                                                   | Captured 200                       |
| `POST`   | `/api/works/open`                                               | —                                     | workId, locale                                      | Client callsite; request validator |
| `POST`   | `/api/works/tasks/perform`                                      | —                                     | workId, taskId, locale, operationId                 | Client callsite; request validator |

## Realtime game hub

The client configures SignalR at `/api/hubs/game` with WebSocket transport and negotiation enabled. The negotiation path is `POST /api/hubs/game/negotiate?negotiateVersion=1`; the runtime negotiation/upgrade and server event payloads have not been independently captured.

[`realtime.json`](../public/api-docs/realtime.json) is a separate machine-readable client-consumption model linked from OpenAPI's `x-realtime`. It records the `gameEvent` envelope, 39 directly consumed/routed event types, payload keys, client checks/coercions, and the invocations `JoinBossBattle(battleId)` and `LeaveBossBattle(battleId)` (one nonempty string argument). It is not an AsyncAPI document or a verified server schema. Unknown payload fields/types remain open; client normalization must not be mistaken for wire validation. Boss room event routing also accepts an envelope-level battleId fallback and case-insensitive key matching.

| Event type                               | Directly consumed payload keys                                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `achievement.unlocked`                   | achievementKey, category, name, description, image, imageUrl, previewImageUrl, previewUrl, iconUrl, icon, threshold, points |
| `boss.inviteAccepted`                    | invitationId                                                                                                                |
| `boss.inviteCancelled`                   | invitationId                                                                                                                |
| `boss.inviteCreated`                     | invitationId, battleId, bossId, playerId, inviterPlayerId, status, battleStatus, expiresAtUtc, bulk, guaranteedReward       |
| `boss.inviteDeclined`                    | invitationId                                                                                                                |
| `boss.inviteExpired`                     | invitationId                                                                                                                |
| `boss.room.forbidden`                    | battleId; may be synthesized by the client                                                                                  |
| `boss.room.joined`                       | battleId                                                                                                                    |
| `boss.room.leader`                       | battleId                                                                                                                    |
| `boss.room.left`                         | battleId                                                                                                                    |
| `boss.room.reconnected`                  | battleId; may be synthesized by the client                                                                                  |
| `boss.room.settled`                      | battleId, reward, status                                                                                                    |
| `boss.room.state`                        | battleId                                                                                                                    |
| `clan.applicationCreated`                | application                                                                                                                 |
| `clan.applicationResolved`               | applicationId, playerId, status                                                                                             |
| `clan.dailyMessageChanged`               | dailyMessage                                                                                                                |
| `clan.disbanded`                         | clanId                                                                                                                      |
| `clan.eventLogged`                       | No payload fields established by this consumer                                                                              |
| `clan.invitationReceived`                | invitation                                                                                                                  |
| `clan.invitationResolved`                | invitationId                                                                                                                |
| `clan.membersChanged`                    | playerId, change, memberCount                                                                                               |
| `clan.permissionsChanged`                | version, rolePermissions, viewerPermissions                                                                                 |
| `clan.progressChanged`                   | level, experience, maxMembers, playerId, weeklyImpact                                                                       |
| `clan.roleChanged`                       | version, playerId, role, viewerMembership                                                                                   |
| `clan.settingsChanged`                   | version, clanPatch                                                                                                          |
| `floor.leaderChanged`                    | No payload fields established by this consumer                                                                              |
| `friend.removed`                         | No payload fields established by this consumer                                                                              |
| `friend.requestAccepted`                 | No payload fields established by this consumer                                                                              |
| `friend.requestCancelled`                | No payload fields established by this consumer                                                                              |
| `friend.requestCreated`                  | relationship                                                                                                                |
| `friend.requestDeclined`                 | No payload fields established by this consumer                                                                              |
| `interaction.boosterGiftReceived`        | No payload fields established by this consumer                                                                              |
| `interaction.boosterRequestCreated`      | No payload fields established by this consumer                                                                              |
| `interaction.boosterRequestFulfilled`    | No payload fields established by this consumer                                                                              |
| `interaction.pillsGiftCampaignCompleted` | No payload fields established by this consumer                                                                              |
| `interaction.pillsGiftReceived`          | pillsBalance                                                                                                                |
| `interaction.stashHelpReceived`          | No payload fields established by this consumer                                                                              |
| `system.bank.purchaseCredited`           | wallet                                                                                                                      |
| `system.clanWeeklyReward`                | walletDollar                                                                                                                |

## Captured response structures (2026-10-20)

The current specification contains 163 paths and 166 operations. Of these, 47 operations have an independently observed successful JSON response structure. Two further operations have observed JSON error responses (GET clan search: 400 without its search query; GET combat battle detail: 404 for an identifier that was not established as a combat battle). These errors describe those probes only, not every possible failure.

A sanitized DevTools HAR provided 683 JSON response samples. Only field names and JSON types were retained; the raw HAR was deleted immediately after parsing. Additional authenticated GET requests provided bank packages, clothing, combat, notification settings, incoming booster gifts, today's pill gifts, customization options, rooms, and clan events. Tokens were used only in process memory. No purchases, battles, gifts, claims or other game mutations were performed for discovery.

[`api-response-coverage.json`](api-response-coverage.json) lists canonical routes, observed status codes and sample counts. The specification marks each captured status with `x-evidence: network-response-shape` and each observed operation with `x-observed-response-statuses`. These sample-derived schemas do not establish requiredness, exhaustive fields, enums or all possible variants. Null-only values and empty arrays do not establish their underlying types. Object dictionaries omit concrete numeric/UUID keys.

Client-normalized schemas remain explicitly client-derived when no successful response was captured. Client coercions and wrappers are not guaranteed wire types. Unobserved mutation responses and errors remain open. Consequently this is a usable client-surface specification with explicit coverage, not a fully confirmed server contract.

### Corrections established during live verification

- Floor details use `GET /api/floors/{code}/info`; the earlier bare floor-code path was incorrect.
- Achievements include `GET /api/achievements/{category}`; `general` and `combat` were observed. Other category keys come from the client configuration.
- `GET /api/bosses/{bossId}/battles` was removed: the only callsite uses POST to start a battle; a GET probe returned 405.
- `GET /api/mini-game/cards` was removed: the client uses the base only for POST try/cancel routes, and a GET probe returned 404.

State-changing operations can spend currency/energy, alter equipment or relationships, or send notifications. Postman blocks them until `allowMutations=true` is explicitly set in the imported environment. The default base URL targets the live game; enabling this flag permits live changes. Swagger UI does not persist authorization.

## Remaining confirmation work

[`api-unverified-operations.json`](api-unverified-operations.json) lists the 119 operations without an observed successful JSON response. Of the successful response definitions, 63 still use an entirely open schema (`{}`); other unverified definitions contain client-derived fields. Mutation responses require existing traffic, an authorized test context, or a server contract to verify without causing live game actions. Requiredness and exhaustive error variants cannot be proven from a finite response capture.

Run `node scripts/validate-api-docs.mjs` to verify canonical operation parity, path parameters, response coverage and blank credentials. This consistency check does not validate the complete OpenAPI meta-schema or prove server behavior.

The specification also passed formal OpenAPI 3.1 validation with `@apidevtools/swagger-parser` on 2026-10-20. The served JSON matched the checked source; Vite production build and `git diff --check` passed. These checks validate the artifacts, not unobserved live operations.

## Client request contracts

93 JSON request bodies now specify the types emitted by client validators, required serialized fields, enums and established constraints. Missing chest bodies, numeric IDs, clan settings fields, notification options, booster categories and state-changing action payloads are included. `x-request-evidence`, request-body `x-client-source` and schema `x-requiredness-source` distinguish these rules from verified server enforcement. [`api-client-request-evidence.json`](api-client-request-evidence.json) records the public bundle URL, SHA-256 and source anchors for each request model.

Postman request bodies use environment placeholders. Numeric, boolean, array, object and mixed-type placeholders are unquoted JSON literals; string placeholders are quoted. Set their values before sending. Queries with established client defaults use those defaults; optional query parameters start disabled. For mutagen exchange type `W`, enable the `level` query parameter with a value between 8 and 20. The shared environment variable `type` must be set for the specific operation (for example, boosters use `small/full`, combat items use `heal_10/heal_full/howl`, and mutagens use `I/A/F/X/S/Z/W`).

A further route audit confirmed `POST /api/friends/requests` through the client's indirect POST wrapper. It is included in OpenAPI and Postman. The two conventional public contract URLs `/swagger/v1/swagger.json` and `/openapi/v1.json` returned the SPA HTML fallback rather than a JSON server contract.
