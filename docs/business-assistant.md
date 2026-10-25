# Business assistant

Authenticated users open the assistant through the existing business **Уровни** action. Public/unauthenticated visitors keep the reference-only upgrade table. Missing reference recipes do not prevent opening the assistant, but unknown requirements remain unknown.

The assistant stores each business's target level, optional manually supplied current level, farming battle cap and last known resource snapshot on the server, scoped to the verified account. Unsaved form edits and the open modal are presentation state only. Personal levels, inventory and prices never enter the public catalogue SQLite file.

## Commands

All use the shared authenticated `/api/automation/commands` envelope:

- `business.select {businessId}` creates/selects a saved plan without contacting the game.
- `business.save {businessId,targetLevel,currentLevelOverride,maxAttempts}` persists the plan; null current-level override means use game data, null battle cap means unlimited. This command makes no game calls.
- `business.refresh {businessId}` explicitly reads `/api/me/bag` and, when a verified numeric business API identifier exists, `/api/businesses/{businessId}`. There is no periodic business/inventory polling against the game.
- `business.goal {businessId,itemId,bossId,expectedMissing,replaceExisting}` re-reads resources, recomputes the deficit, checks the reviewed amount and source boss, then creates a `business_items` goal. It does not start a fight, enable Auto, purchase materials or upgrade the business.

The shared state snapshot includes `businessAssistant` with saved server-computed `plans`, selection, notice and refresh time. An existing active goal requires explicit replacement confirmation. An active battle with another boss prevents goal switching. Changed inventory returns the updated plan for review instead of silently increasing the target. A manual level that contradicts freshly verified game data cannot create a farming goal until corrected.

## Calculation and uncertainty

Material requirements sum the known catalogue rows strictly above current level through the target. Current level comes from the business detail response or an explicitly labelled manual override; absence is not level zero. A target already reached has zero remaining material requirements.

The bag parser accepts an `activityItems` array with safe integer item IDs and quantities. A complete valid snapshot implies zero for absent items. Incomplete, malformed or ambiguous rows leave the affected quantities unknown. Negative or non-integer values are not converted into quantities.

Bosses are matched to each material by activity-item identity from canonical catalogue drops; displayed names are not an identity substitute. Source notes and discrepancies in source totals remain visible. Recipe rows missing for a level produce unknown requirements rather than invented values or boss-kill estimates.

Only a recognized literal `nextUpgradePrice` and known `nextUpgradeCurrency`/`currency` can supply a monetary quote. It is bound to the actual current level. That quote is the exact total only for the next single level; no formula is assumed for later levels. Multi-level totals remain unknown unless supported by future verified data. Wallet sufficiency is not inferred from a price.

Local OpenAPI describes these fields but marks parts of business price/item wire formats unverified; unsupported response formats therefore remain unknown. Tests use synthetic responses for parsing, cost handling, deficits, account isolation, restart persistence and goal creation. No real game requests, upgrades or purchases are sent for verification.

## Последовательный серверный сбор

`business.run.start` запускает один приватный серверный маршрут по сохранённому
плану бизнеса. Клиент передаёт проверенные пользователем `expectedPlan` и список
`expectedMissing: [{itemId, amount}]`. До первого боя сервер заново читает бизнес
и инвентарь; изменение расчёта требует нового запуска. Настройки маршрута
фиксируются на весь запуск. `bossChoices` позволяет выбрать подтверждённого
справочником босса для материала, иначе используется первый источник.

Материалы собираются последовательно. Для каждого создаётся внутренняя цель
`business_items`, которой управляет существующая серверная серия боёв. После
достижения цели снова проверяется инвентарь; случайно полученные материалы
следующих этапов учитываются, собранные этапы пропускаются. Покупки, лечение и
повышение уровня бизнеса автоматически не выполняются.

`maxAttempts` ограничивает число начатых боёв **всего маршрута**, включая
проигранные бои и подхваченный активный бой. Последний разрешённый бой может
закончиться, но новый не начинается. `durationHours` — 1, 2, 4 или `null`;
по умолчанию 2 часа. В полном сборе хотя бы один из двух лимитов должен быть
конечным. Время останавливает и текущие автоудары. Достижение лимита не сдаёт
текущий бой.

`business.run.stop` — срочная идемпотентная остановка намерения сбора, доступная
и во время запроса. Она отменяет запланированные этапы/удары и останавливает
внутреннюю цель. Уже отправленный запрос может завершиться, но новые действия
после остановки не отправляются. `auto.stop` и `goal.stop` также останавливают
весь маршрут. Ручные удары, смена босса и замена цели блокируются на время сбора.

Маршрут, счётчики уникальных battleId, фиксированные настройки и текущий этап
хранятся в зашифрованной серверной записи `businessHelper.run`, независимо от
браузера. При перезапуске воркера безопасный этап возобновляется; сохранённый
незавершённый POST, неизвестный результат покупки/боя или ошибочный ответ
останавливает маршрут без повтора игрового действия. Клиент получает статус,
лимиты, материалы и причину остановки через существующий `/api/automation/state`.
