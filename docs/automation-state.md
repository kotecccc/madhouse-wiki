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
