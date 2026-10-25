# Server-owned automation

The wiki server owns personal battle state, goal settings and confirmed per-battle results, auto enablement and execution checkpoints, favorite boss IDs, command receipts, and the credential needed for background execution. React only renders snapshots and submits commands. Open dialogs and selected UI screens remain local presentation state.

## API

- `GET /api/automation/state` returns `{version, serverTime, battle, goal, auto, pvp, preferences}` for the authenticated game account. It does not forward a read of the entire battle to the game on every poll.
- `POST /api/automation/commands` accepts `{id, expectedVersion, command, args}`. The command ID is recorded before dispatch. Duplicate IDs, concurrent actions and stale versions are rejected with HTTP 409 and a current snapshot; the client does not retry mutations.
- Supported commands: `open`, `refresh`, `hydrate`, `start`, `next`, `attack`, `medicines.open`, `medicines.close`, `medicine.use`, `purchase.prepare`, `purchase.cancel`, `purchase.buy`, `purchase.ack`, `auto.start`, `auto.stop`, `goal.configure`, `goal.stop`, `goal.reset`, `pvp.refresh`, `favorites.set`.
- Favorite settings use `favorites.set` with `{bossIds: [positive game boss IDs]}`. New automation settings must use this authenticated server boundary, not localStorage.

Identity is verified using the bearer-authenticated game `/api/me` response. Caller-supplied player IDs and unverified JWT subjects cannot select an account. Verified identities are cached for five minutes to avoid one bot request per browser poll. A token rotation preserves state for the same verified player. Credentials and private account identity are never returned in state snapshots.

## Durable storage and worker

DEV and VPS Compose mount the `automation_state` named volume at `/data/automation`. `MADHOUSE_AUTOMATION_STATE_DIR` selects this directory. It is separate from `local-data/madhouse.sqlite`, which remains a public reference catalogue.

The directory is private (0700), the SQLite database and encryption key are 0600. Account row keys are HMAC-derived; each account record is AES-256-GCM encrypted with its row key as associated data. Both `automation.sqlite` and `encryption.key` are required for recovery. SQLite WAL uses `synchronous=FULL`. An encrypted account record is bounded at 4 MiB to accommodate long series deduplication history; writes beyond that bound fail closed rather than allowing untracked actions.

One wiki process runs the actors. A durable singleton lease in the same SQLite database excludes competing workers; it is renewed every second, expires after fifteen seconds, and is checked before state writes and game mutations. This is a **single-host, shared-volume** design. Do not deploy independent replicas with separate volumes. Move coordination to a shared transactional database before introducing multiple hosts.

Auto runs independently of browser connections. Closing or reloading the page does not stop it. On server restart, enabled work resumes only after reading the current battle, retaining the saved next-action deadline. If the previous process stopped during a pending action, or the state was already uncertain, auto stays off: its POST is never replayed. The user can inspect and refresh the battle explicitly. Server-side storage failure or lease loss prevents new game actions.

When Auto is enabled with an active goal, a server-only series supervisor starts the next fight after a confirmed result. It rechecks goal progress, limits and the game start preflight before each new battle. It does not buy or use medicine automatically. Without a goal Auto remains a single-battle mode.

The series keeps Auto enabled between fights and saves its `phase`, `nextBattleAt` and single-battle strike checkpoint. A pending/uncertain start is never replayed after restart. A clean between-battle checkpoint resumes after the same preflight. Refused starts, unknown required rewards and request errors stop the series without retries.

`auto.stop` cancels the queued next fight and invalidates an in-flight preflight before its POST, preserving the goal. `goal.stop` also stops the goal. Explicit stop commands work even when another command is pending. An already submitted game request may still finish. The modal and bottom dock retain a stop control throughout transitions; manual starts/next commands cannot compete with an enabled series.

## Live-traffic gate and development

The normal runtime is enabled by default, including DEV Compose. Authenticated UI commands reach the server; tests still use fake upstream responses and do not submit real strikes or purchases.

`MADHOUSE_AUTOMATION_GAME_ENABLED=0` is an explicit operator kill switch. It returns HTTP 503 `automation_game_requests_disabled` before authentication or game traffic; do not set it merely to avoid live verification during development. DEV Compose reads the flag from the environment; VPS Compose reads `wiki.env`. Recreate the wiki service with the same volume after changing it. No browser-only fallback runs.

Tests use temporary stores, fake upstream responses and injected timers. Cover account isolation, rotated tokens, process restart, goal counters, command receipts, uncertain POSTs, competing worker leases, and client disconnects.

## Backup and migration boundaries

Back up the complete automation volume, including the key. Stop the wiki worker before copying SQLite/WAL files, or use a consistent SQLite backup procedure. Keep backups private and encrypted. Do not remove the named volume during normal container updates (`down -v` destroys it).

Historical in-memory goal progress was never durable and cannot be reconstructed after the old page is gone. Old localStorage battle references are no longer read or written by the application. An active battle is adopted from an explicit authenticated game reference or a manual boss open; no scan over every boss is used.

## Goal variants

- `battles`: `targetCount` confirmed completed battles, including wins and losses. A failed start is not a completed battle. Each battle ID contributes once.
- `business_items`: `itemKey` identifies one activity item from that boss's catalogue drops, with a positive `targetCount`. Only granted reward quantities from new goal battles increase the count; a battle without the item adds nothing.
- `drops`: `selection` is `all` or `selected` (with `itemKeys`). The server resolves and freezes the list from the boss catalogue at creation. Every selected item identity must be received at least once. Matching uses IDs/type, never names or an inventory guess.
- `time`: `durationHours` is 1, 2, 4 or null (unlimited). The deadline is computed on the server, persisted, and checked immediately before each game mutation. After the deadline no new POST is submitted; an already submitted request can still finish. Unlimited goals run until stopped or an optional battle limit is reached.

For non-battle-count goals `maxAttempts` may be null, or a positive safety cap on started battles. The last permitted battle can finish before exhaustion. Unknown reward payloads do not grant progress. Repeated and late reward snapshots are reconciled per battle so quantities are not counted twice. Old victory goals are migrated in the stopped state and require a new configuration; their meaning is not silently changed into a running battle-count goal.

Полный сбор материалов бизнеса управляется `scripts/automation/business-collector.mjs`
над сериями боёв. `business.run.start` / `business.run.stop` используют те же
проверки аккаунта, ожидаемой версии и квитанции команд. Остановка допускается
поверх выполняющейся команды. Запись `businessHelper.run` входит в серверный
checkpoint; boot восстанавливает работающий сбор даже между этапами, когда
внутренний `auto.enabled` уже выключен. В клиентской проекции auto остаётся
включённым на весь маршрут, чтобы нижняя плашка сохраняла кнопку остановки.

Работёнки используют `workFarm` в той же приватной серверной записи и
`scripts/automation/work-farm.mjs`. Команды work.refresh/work.plan/work.start/work.stop
не требуют отдельного хранилища клиента. work.stop — срочная команда, допускается
во время выполняющегося запроса. Boot возобновляет безопасное намерение без
подключения браузера; checkpoint с pending POST останавливается без повторения.
Подробности расчёта и доказательств API-контракта — в `docs/work-farm.md`.

Завершение боёв: статус `timed_out` нормализуется в `expired` по обработчику
публичного клиента. Подтверждённые lost/expired/surrendered доступны для нового
ручного запуска так же, как won; перед новым POST обязательно читается свежий
boss summary и проверяется `canStartFight`. Ненулевая терминальная запись
`activeBattle` сама по себе не блокирует запуск, если сервер разрешил его.

Истёкший срок, нулевое HP или неизвестный статус вызывают одну серверную
GET-перепроверку на бой/причину, без постоянного опроса и без surrender POST.
Если детальный бой удалён (404/410) или остаётся устаревшим, проверяется текущая
сводка босса. Только ответ сервера подтверждает отсутствие активного боя; сам
таймер не создаёт фиктивное поражение и не увеличивает счётчики цели.
409 `battle_finished` с совпадающим ID и известным терминальным статусом
принимается как результат боя, без нового события удара и без повторения POST.

## Account read snapshots (iteration 1)

The VPS runtime now serves personal GET readers through `scripts/account/snapshots.mjs`
before the existing documented game transport. DEV uses the same snapshot gateway
for these routes. This remains our API: the browser has no durable snapshot store.

| Reader / surface                                        | Snapshot sections and boundary                                                                                                                                                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profile, login summary, calculators                     | `/api/me`: profile, stats, wallet, energy, level and experience                                                                                                                                                                  |
| Floor opening and progression requirements              | `/api/floors`, `/api/floors/{code}/info`: account availability, current/met requirements, department access and business levels                                                                                                  |
| Boss drop collection                                    | `/api/rooms`, `/api/clothing`, `/api/ornaments/zones/{id}`, `/api/weapons/{id}`, `/api/pets/{id}`: explicit owned/unlocked flags; existing collection semantics retain unknown values                                            |
| Inventory and business assistant                        | `/api/me/bag`, `/api/businesses/{id}`; server automation reads also update these sections                                                                                                                                        |
| Boss detail                                             | `/api/bosses/{id}`; existing public reference import still projects only allowlisted reference fields                                                                                                                            |
| Battle, goals, preferences, farm and business execution | Existing private automation actor records remain canonical; battle GETs are live-only, never stale inputs for actions. `/api/combat` and battle detail reads remain live; the last confirmed actor projection survives failures. |
| Work cycle reader                                       | `/api/works/open` is POST despite being a state reader. Its normalized latest view already lives in the private work-farm record. It is not replayed or generically cached as a GET.                                             |
| Encyclopedia, raids, media, bot inline cards            | Public reference catalogue and existing raid storage; independent of personal snapshots and game availability. No new per-account scans.                                                                                         |

The allowlist deliberately covers current consumers rather than every documented
GET. Query-bearing reads and other API documentation operations stay live-only;
they cannot overwrite a baseline snapshot with a filtered response. Collection
sections are requested only for known drops used by the opened surface. This is
incremental coverage, not an atomic scan of the entire game account. An unvisited
section or an evicted section remains unknown until successfully requested.

`account_snapshots` is a separate table in the existing private `automation.sqlite`,
using the same private directory, HMAC account keys, AES-GCM encryption and FULL
SQLite transactions. No personal data is written to public `madhouse.sqlite`.
Each account has one schema-version-1 record with current sections, timestamps,
health, and at most eight hashes of verified bearer credentials. Identity comes
from successful game `/api/me`, or an exact credential already bound to a verified
account in private storage; JWT claims and caller IDs cannot select accounts.
No raw credential is added to snapshot data. Secret-shaped fields are recursively
removed; existing encrypted automation credentials remain in their existing record.

Limits are 128 sections, 1 MiB per section and 3 MiB per account snapshot, with
oldest sections evicted first while retaining `/api/me`. Response bodies are read
with a byte limit. Successful section replacements are committed atomically;
concurrent updates reread the current account record before replacing a section.
There is no response history. Sparse objects preserve known fields when fields
are omitted or null; successful arrays replace arrays (including legitimate empty
lists). Explicit partial/error envelopes, malformed JSON and oversized responses
are failures and preserve the prior successful section. The upstream has no
universal completeness marker, so an otherwise successful empty list is treated
as authoritative. Unknown ownership is never converted to zero or a complete set.

The server TTL is three minutes. Identical concurrent reads are deduplicated and
reads are serialized per account; at most 256 in-flight section requests are
accepted. UI fallback reads and mandatory-live automation reads use separate
in-flight keys so automation can never inherit a stale UI response. The existing
client memory cache is also three minutes; effective display age may therefore
reach roughly six minutes without an explicit refresh. A mutation dirties cached
sections so the next demand refreshes them. There is no browser snapshot timer,
account sweep, new cron or background polling of all endpoints.

Timeout/network failures, 429, 5xx and malformed successful responses record an
observed outage with a 30-second retry cooldown. A previously successful section
is returned with HTTP 200 and `X-Madhouse-Snapshot: stale`; a missing section
returns 503 `snapshot_unknown`. The game request deadline is eight seconds, below
the browser request deadline. Read responses also expose
`X-Madhouse-Game-Status`, `X-Madhouse-Last-Success` and
`X-Madhouse-Section-Updated`. These timestamps describe successful section reads,
not a simultaneous whole-account snapshot. An endpoint failure is cleared by
successful refresh of that endpoint; a successful unrelated endpoint does not
hide partial unavailability. Recovery is demand-driven after the cooldown.

Game HTTP 401 records invalid credentials separately; it never becomes a stale
success. HTTP 403 remains a permission refusal and does not revoke an entire
account. Wiki launch identity validation stays in the connector and remains a
separate error. Existing session expiry and logout rules still apply: this first
iteration does not create a new long-lived Wiki login or grant access to an
unknown credential during an outage. A verified, restorable session can read its
saved sections after browser/server restart without contacting a healthy game.

The bottom navigation warning uses a shared UI Kit Button variant and Dialog.
It explains section staleness, last successful update and paused actions. Normal
initial/anonymous `unknown` is quiet; first-read failure reports unavailable with
no successful timestamp. Recovery updates the existing indicator without toasts.
Automation state responses carry the same health projection, using the existing
server-state subscription rather than a new game polling loop.

Known unavailability blocks action-start commands before dispatch and blocks every
game mutation at the shared server fetch boundary, including existing workers.
Stop commands and private preference/goal edits remain usable. Live automation
reads never fall back to stale bodies. Existing pending receipts, uncertain
checkpoints, durable serialization and no-replay rules remain unchanged. There
is no durable deferred-action queue and no automatic replay on recovery; a future
queue must distinguish unsent, submitted and uncertain operations and reuse the
same account/receipt/checkpoint boundary. The single-host worker lease and volume
backup requirements above still apply. Neither deploy nor live-game verification
is required by this local implementation; tests inject fake upstream responses.
