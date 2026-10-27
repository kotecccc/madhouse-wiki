# Резервная копия и изолированное восстановление automation state

Этот runbook охватывает только `/data/automation`: согласованный снимок
`automation.sqlite` в WAL-режиме и его `encryption.key`. Архив обязан пройти через
`age` до записи на диск. Идентификатор `age`, `rollback-floor.env`, Docker image,
Telegram storage и другие ключи в архив не входят; для них нужны отдельные
проверенные процедуры. Floor остаётся в root-controlled каталоге хоста и не
откатывается восстановлением SQLite.

## Требования перед запуском

- Указать точный Wiki image по полному source SHA и соответствующий release
  marker. Проверить свободное место в `/tmp` контейнера: снимок создаётся там и
  должен целиком помещаться в private tmpfs.
- На хосте установить и проверить `age`. Публичный recipient должен
  соответствовать identity, сохранённому отдельно от VPS. Identity хранить
  офлайн с правами `0600`; не копировать его на VPS.
- Подготовить каталог резервных копий с правами `0700`, зашифрованную retention
  политику и новый уникальный путь для файла. Не писать plaintext archive,
  ключ базы или распакованный SQLite на диск.
- Не выполнять восстановление в production volume. Для drill создать отдельный
  пустой Docker volume, запретить сетевой доступ контейнеру и удалить этот
  volume после проверки.

## Снять зашифрованную копию

Ниже пример для уже работающего Compose-проекта. Он не останавливает Wiki;
backup helper использует SQLite snapshot API, включая committed WAL state.

```sh
set -euo pipefail
umask 077
set -o noclobber
: "${AGE_RECIPIENT:?set the public age recipient}"
: "${BACKUP_FILE:?set a new destination path}"
COMPOSE_FILE=/opt/madhouse-wiki/vps-compose.yml
RELEASE_ENV=/opt/madhouse-wiki/release.env

if ! docker compose \
  --project-name madhouse-wiki \
  --file "$COMPOSE_FILE" \
  --env-file "$RELEASE_ENV" \
  exec -T \
  --env MADHOUSE_AUTOMATION_SNAPSHOT_TMPDIR=/tmp/madhouse-automation-snapshot \
  wiki sh -euc 'tmp=/tmp/madhouse-automation-snapshot; trap "rmdir $tmp 2>/dev/null || true" EXIT; mkdir -m 700 "$tmp"; node /app/scripts/automation/backup-state.mjs' \
  | age --recipient "$AGE_RECIPIENT" > "$BACKUP_FILE"; then
  rm -f -- "$BACKUP_FILE"
  exit 1
fi
```

Проверить, что архив открывается только заданным offline identity, не сохраняя
расшифрованные байты:

```sh
age --decrypt --identity "$AGE_IDENTITY" "$BACKUP_FILE" > /dev/null
sha256sum "$BACKUP_FILE"
```

Записать рядом только дату, source SHA, размер, digest архива и fingerprint
recipient. Не записывать identity, SQLite key или plaintext manifest.

## Провести drill в отдельном volume

Использовать точный уже проверенный image tag. Следующий пример создаёт volume,
который не подключён ни к одному Wiki Compose service:

```sh
set -euo pipefail
: "${AGE_IDENTITY:?set the offline age identity path}"
: "${BACKUP_FILE:?set the encrypted backup path}"
: "${RESTORE_VOLUME:?set a new isolated volume name}"
: "${WIKI_IMAGE:?set madhouse-wiki:vps-<verified-source-sha>}"

if docker volume inspect "$RESTORE_VOLUME" > /dev/null 2>&1; then
  echo "restore_volume_already_exists" >&2
  exit 1
fi
docker volume create "$RESTORE_VOLUME" > /dev/null
docker run --pull=never --rm --network none --user 0 \
  --mount "type=volume,source=$RESTORE_VOLUME,target=/data/restore" \
  --entrypoint chown "$WIKI_IMAGE" node:node /data/restore

age --decrypt --identity "$AGE_IDENTITY" "$BACKUP_FILE" \
  | docker run --pull=never --rm -i --network none --read-only \
      --mount "type=volume,source=$RESTORE_VOLUME,target=/data/restore" \
      "$WIKI_IMAGE" /app/scripts/automation/restore-state.mjs \
      --directory /data/restore
```

Контейнер восстановления не имеет сети, а `--directory` обязан быть пустым.
При любой ошибке код оставляет `restore-required` и не объявляет базу готовой;
такой тестовый volume удалить и начать drill заново. Не удалять маркер вручную и
не продолжать на частично восстановленном volume.

Проверить глобальный restore guard отдельным одноразовым контейнером без сети:

```sh
docker run --pull=never --rm --network none --read-only \
  --mount "type=volume,source=$RESTORE_VOLUME,target=/data/restore" \
  "$WIKI_IMAGE" --input-type=module -e '
    import { createAutomationStateStore } from "/app/scripts/automation/state-store.mjs";
    const store = createAutomationStateStore({ directory: "/data/restore" });
    const guarded = store.isRestoreGuardActive();
    store.close();
    if (!guarded) process.exitCode = 1;
    else console.log("restore_guard_active");
  '
```

Зафиксировать source SHA image, digest backup, факт SQLite integrity check,
`restore_guard_active`, длительность, размер и ошибку/успех. До свежего
подтверждения владельца actor не должен выполнять игровые mutations; старые
цели, device records и renewal consent не считать актуальным подтверждением.
Отсутствие сохранённой политики маршрута не разрешает прямое подключение:
требуется отдельный подтверждённый выбор. После восстановления владелец проходит
свежую проверку Telegram, явно выбирает direct и подтверждает одноразовый challenge.
Затем он запускает новый вход через Connector; сервер проверяет владельца и
профиль игры, записывает новый credential в отдельное приватное хранилище и
привязывает аккаунт. После этого владелец проверяет восстановленное состояние и
отдельно подтверждает его. Старый credential или устройство не восстанавливают
доверие автоматически.

При неопределённом результате входа система не повторяет отправку автоматически:
сначала предлагается проверить сохранённый результат. Если его нет, явное
подтверждение неизвестного результата предупреждает о возможной старой игровой
сессии; новый вход потребует отдельного подтверждения и новых launch-данных.
Неопределённые игровые действия остаются заблокированы до предусмотренной для
них сверки; подтверждение просмотра не повторяет их. Не отключать guard вручную
и не считать аккаунт готовым, пока состояние восстановления не сообщает `ready`.
Повторно сверить host rollback floor с сохранённым до drill значением. После
сбора результатов удалить только тестовый volume:

```sh
docker volume rm "$RESTORE_VOLUME"
```

## Текущие ограничения

Этот документ готовит процедуру, но не подтверждает её на хосте. На Mac-хосте
задачи age не установлен. 27 октября 2026 локально прошёл отдельный
synthetic smoke с настоящим age 1.1.1 в одноразовом Debian 12 helper image:
зашифрованный snapshot восстановился в новый временный target, SQLite открылся,
а restore guard остался активен. Контейнеры backup/restore работали без сети;
временные image, identity, archive и state удалены после проверки. Это не
проверяет production image, named Docker volume, VPS recipient/identity или
реальную базу. Изолированный тест с настоящим age восстановил оба хранилища и
проверил подтверждение владельца, новую привязку и сохранение ограничений при
неопределённом действии; синтетические данные не подтверждают production recovery.
На VPS отсутствовали rollback floor и поддержка пространства credentials в
установленном storage server при проверке 27 октября 2026; перед работами эти
наблюдения нужно обновить. Объём automation DB, retention, RPO/RTO, custody ключей
и изолированный host restore остаются непроверенными. Перед эксплуатацией нужно
измерить, что snapshot помещается в контейнерный tmpfs, и отдельно проверить
копию private storage и deployment secrets.
Локальные тесты в `tests/automation-state-backup.test.mjs` проверяют WAL
snapshot, integrity, tamper rejection и restore guard с синтетическими данными;
они сами age не используют.
