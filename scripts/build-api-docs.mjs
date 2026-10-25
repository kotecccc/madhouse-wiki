import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import prettier from "prettier";
const httpMethods = new Set(["get", "post", "put", "patch", "delete"]);

const readJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const source = await readJson("../public/api-docs/openapi.json");
const russian = await readJson("../docs/api-readonly.ru.json");
const fieldDescriptions = {
  id: "Идентификатор записи.",
  name: "Название.",
  nickname: "Игровое имя.",
  username: "Имя пользователя Telegram.",
  firstName: "Имя пользователя.",
  playerId: "Идентификатор игрока.",
  telegramId: "Идентификатор пользователя Telegram.",
  userId: "Идентификатор пользователя.",
  bossId: "Идентификатор босса.",
  battleId: "Идентификатор боя.",
  floorCode: "Код этажа.",
  categoryId: "Идентификатор категории.",
  items: "Записи списка.",
  entries: "Участники рейтинга и их показатели.",
  nextCursor:
    "Курсор следующей страницы. Передайте его в cursor для продолжения списка.",
  level: "Уровень.",
  maxLevel: "Максимальный уровень.",
  requiredLevel: "Требуемый уровень.",
  title: "Название.",
  titleKey: "Ключ локализации названия.",
  nameKey: "Ключ локализации имени.",
  nameRu: "Имя на русском.",
  nameEn: "Имя на английском.",
  description: "Описание.",
  imageUrl: "Адрес изображения.",
  avatarUrl: "Адрес изображения профиля.",
  cdnBaseUrl: "Базовый адрес файлов и изображений.",
  status: "Текущее состояние записи.",
  success: "Признак успешного выполнения запроса.",
  version: "Версия данных.",
  createdAtUtc: "Время создания в UTC.",
  expiresAtUtc: "Срок действия в UTC.",
  occurredAtUtc: "Время события в UTC.",
  completedAtUtc: "Время завершения в UTC.",
  unlockedAtUtc: "Время открытия в UTC.",
  serverTimeUtc: "Время сервера в UTC.",
  resetAtUtc: "Время сброса периода в UTC.",
  nextResetAtUtc: "Время следующего сброса в UTC.",
  weekStartUtc: "Начало недели рейтинга в UTC.",
  cooldownUntilUtc: "Окончание задержки до следующего действия в UTC.",
  retryAfterMilliseconds: "Задержка до повторного действия, в миллисекундах.",
  wallet: "Кошелёк игрока.",
  gold: "Золото.",
  dollar: "Доллары.",
  pills: "Пилюли.",
  exp: "Опыт.",
  energy: "Состояние энергии.",
  player: "Данные игрока в этом разделе.",
  catalog: "Каталог раздела.",
  characterStats: "Характеристики персонажа.",
  characterStatsUpgrade: "Параметры улучшения характеристик.",
  boosters: "Бустеры в сумке.",
  activityItems: "Предметы активности.",
  combatItems: "Боевые предметы.",
  activeStashBuff: "Активный эффект набора.",
  currentIncome: "Доход на текущем уровне бизнеса.",
  nextLevelIncome: "Доход на следующем уровне бизнеса.",
  currentRewards: "Награды бизнеса на текущем уровне.",
  nextLevelRewards: "Награды бизнеса на следующем уровне.",
  currency: "Валюта.",
  nextUpgradeCurrency: "Валюта следующего улучшения.",
  nextUpgradePrice: "Стоимость следующего улучшения.",
  requiredItems: "Предметы, необходимые для действия.",
  requiredAmount: "Требуемое количество предмета.",
  playerAmount: "Количество предмета у игрока.",
  canUpgrade: "Доступно ли улучшение текущему игроку.",
  canCollect: "Готов ли доход к сбору.",
  nextCollectionAt: "Время следующего сбора.",
  secondsUntilCollection: "Время до сбора, в секундах.",
  businesses: "Бизнесы.",
  departments: "Отделения.",
  income: "Показатель дохода этажа.",
  totalIncome: "Общий показатель дохода.",
  cycleIncome: "Доход за цикл.",
  totalCycleIncome: "Общий доход за цикл.",
  readyToCollectCount: "Число бизнесов, готовых к сбору.",
  totalReadyToCollectCount: "Общее число бизнесов, готовых к сбору.",
  collectAllCostPills: "Стоимость общего сбора в пилюлях.",
  canCollectAll: "Доступен ли общий сбор.",
  floorLeader: "Лидер этажа.",
  myFloorScore: "Показатели текущего игрока на этаже.",
  floorTribute: "Сведения о дани этажа.",
  maxHp: "Максимальное здоровье босса.",
  damageMin: "Нижняя граница урона.",
  damageMax: "Верхняя граница урона.",
  rewardUntilLevel: "Уровень, до которого действует награда за босса.",
  maxFightDurationSeconds: "Максимальная длительность боя в секундах.",
  maxParticipants: "Максимальное число участников.",
  surrenderDollarCost: "Стоимость сдачи в долларах.",
  rewardPreview: "Предварительные сведения о награде.",
  possibleDrops: "Возможные предметы награды.",
  activeBattle: "Активный бой, если он есть.",
  myKillCount: "Число побед текущего игрока над боссом.",
  topKiller: "Лидер по числу побед над боссом.",
  participantCount: "Число участников.",
  participants: "Участники боя.",
  turn: "Текущий ход.",
  playerHealth: "Текущее здоровье игрока.",
  playerMaxHealth: "Максимальное здоровье игрока.",
  bossHealth: "Текущее здоровье босса.",
  bossMaxHealth: "Максимальное здоровье босса.",
  opponentHealth: "Текущее здоровье противника.",
  opponent: "Противник.",
  myDamage: "Урон текущего игрока.",
  damageDealt: "Нанесённый урон.",
  rewardEligible: "Есть ли право на награду.",
  myRewardEligible: "Есть ли право на награду у текущего игрока.",
  reward: "Сведения о награде.",
  granted: "Признак выдачи награды.",
  dropDamageRequired: "Порог урона, связанный с получением предмета.",
  howlHitsRemaining: "Оставшееся число ударов с эффектом воя.",
  clanImpactAwarded: "Начислен ли вклад клана.",
  combatRating: "Боевой рейтинг.",
  candidates: "Кандидаты на бой.",
  secondsToNext: "Время до следующего восстановления, в секундах.",
  regenIntervalSeconds: "Интервал восстановления энергии в секундах.",
  refillPillCost: "Стоимость пополнения энергии в пилюлях.",
  categories: "Категории.",
  achievements: "Достижения.",
  progress: "Текущий прогресс.",
  threshold: "Порог выполнения.",
  unlocked:
    "Состояние открытия или число открытых записей — в зависимости от поля схемы.",
  totalUnlocked: "Общее число открытых достижений.",
  total: "Общее количество.",
  points: "Очки.",
  totalPoints: "Общее число очков.",
  rank: "Место в рейтинге.",
  currentDay: "Текущий день серии.",
  claimedToday: "Получена ли награда за текущий день.",
  canClaim: "Доступно ли получение награды.",
  streakBroken: "Прервана ли серия.",
  totalClaims: "Общее число получений.",
  rewards: "Награды.",
  dailyReward: "Состояние ежедневной награды.",
  clan: "Сведения о клане.",
  membership: "Членство текущего игрока.",
  applications: "Заявки на вступление.",
  invitations: "Приглашения.",
  rules: "Правила.",
  experienceForNextLevel: "Значение опыта для следующего уровня.",
  weeklyImpact: "Вклад за неделю.",
  totalImpact: "Общий вклад.",
  dollarPerMember: "Долларов на одного участника.",
  previousWeek: "Результаты предыдущей недели.",
  notificationId: "Идентификатор уведомления.",
  isRead: "Прочитано ли уведомление.",
  unreadCount: "Общее число непрочитанных уведомлений.",
  unreadByCategory: "Число непрочитанных уведомлений по категориям.",
  options: "Переключатели настроек: ключ настройки и булево значение.",
  recipientPlayerIds: "Идентификаторы получателей подарков в текущем периоде.",
  recipes: "Рецепты.",
  selectedLevel: "Выбранный уровень.",
  availableLevels: "Доступные уровни.",
  mutagens: "Мутагены.",
  installedMutagen: "Установленный мутаген.",
  installPillCost: "Стоимость установки в пилюлях.",
  extractionPillCost: "Стоимость извлечения в пилюлях.",
  helpRequestedItems: "Предметы, по которым запрошена помощь.",
  sets: "Наборы.",
  minStars: "Минимальное значение звёзд в предложении.",
  maxStars: "Максимальное значение звёзд в предложении.",
  starsAvailable: "Доступность звёзд по данным ответа.",
  stage: "Этап.",
  startCost: "Стоимость старта.",
  nextStartCost: "Стоимость следующего старта.",
  freeStart: "Доступность бесплатного старта.",
  chipBalance: "Баланс фишек.",
  chipPurchase: "Параметры покупки фишек.",
  maxExchanges: "Максимальное число обменов.",
  activeGame: "Активная игра, если она есть.",
  rerollProgression: "Прогрессия перебросов.",
  exchangeProgression: "Прогрессия обменов.",
  lastJackpot: "Данные последнего джекпота.",
  lastWinner: "Данные последнего победителя.",
  currentQuestId: "Идентификатор текущего задания.",
  quests: "Задания.",
  TaskID: "Идентификатор раздела, возвращаемый сервером.",
};
const parameterDescriptions = {
  bossId: "Идентификатор босса.",
  clanId:
    "Идентификатор клана. Можно взять из /api/clans/me, поиска или рейтинга кланов.",
  businessId:
    "Идентификатор бизнеса из businesses в ответе /api/floors/{code}/info.",
  playerId:
    "Идентификатор игрока из профиля, списка друзей, поиска или рейтинга.",
  targetPlayerId: "Идентификатор игрока, чьи запросы помощи нужно посмотреть.",
  campaignId:
    "Идентификатор ранее созданной рассылки подарков. Нужна рассылка, доступная текущему аккаунту.",
  code: "Код этажа из ответа /api/floors, например A. Регистр передавайте как в исходных данных.",
  section: "Идентификатор раздела заданий.",
  category: "Ключ категории. Выберите значение из списка допустимых значений.",
  direction:
    "Направление приглашений. Выберите значение из списка допустимых значений.",
  status:
    "Состояние приглашений. Выберите значение из списка допустимых значений.",
  limit:
    "Максимальное число записей в ответе. Ограничения и значение по умолчанию указаны в схеме параметра.",
  cursor:
    "Курсор продолжения из предыдущего ответа. Для первой страницы оставьте параметр выключенным.",
  page: "Номер страницы, начиная с 1.",
  day: "День, по которому нужно отфильтровать журнал клана. Без параметра фильтра по дню нет.",
  unreadOnly:
    "true — только непрочитанные уведомления; false — без этого ограничения.",
  query: "Строка поиска.",
  prefix: "Начало имени: не менее трёх символов без учёта начального @.",
  type: "Тип мутагена: I, A, F, X, S, Z или W. Выберите точное значение из списка.",
  level:
    "Уровень для type=W: от 8 до 20. Для других типов этот параметр оставьте выключенным.",
};
const idDescriptions = {
  "/api/clothing/by-category/{id}":
    "Идентификатор категории одежды. Клиент использует значения от 1 до 9.",
  "/api/clothing/sets/{id}": "Идентификатор набора одежды из каталога.",
  "/api/ornaments/sets/{id}": "Идентификатор набора украшений.",
  "/api/ornaments/sets/{id}/zones":
    "Идентификатор набора украшений, зоны которого нужно получить.",
  "/api/ornaments/zones/{id}": "Идентификатор зоны украшений.",
  "/api/weapons/{id}": "Идентификатор оружия.",
  "/api/pets/{id}": "Идентификатор питомца.",
};

function localizeSchemas(value, name) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) localizeSchemas(item);
    return;
  }
  // Discovery provenance stays in the complete source specification, not in reader-facing schemas.
  delete value.description;
  if (name && fieldDescriptions[name])
    value.description = fieldDescriptions[name];
  if (name === "unlocked" && value.type === "boolean")
    value.description = "Открыт ли объект текущему игроку.";
  if (name === "unlocked" && value.type === "integer")
    value.description = "Число открытых записей.";
  for (const [key, nested] of Object.entries(value)) {
    if (key === "properties" && nested && typeof nested === "object") {
      for (const [field, schema] of Object.entries(nested))
        localizeSchemas(schema, field);
    } else if (key !== "description") localizeSchemas(nested);
  }
}

const result = {
  openapi: source.openapi,
  info: { title: "Madhouse", version: source.info.version },
  servers: [
    {
      url: "http://127.0.0.1:4174",
      description: "Сервер запросов через локальный прокси",
    },
  ],
  security: structuredClone(source.security),
  tags: [],
  paths: {},
  components: structuredClone(source.components),
};
const usedTags = new Set();
let count = 0;
for (const [path, methods] of Object.entries(source.paths)) {
  if (!methods.get) continue;
  const text = russian.operations[path];
  assert(
    text?.summary && text?.description && text?.response,
    `Нет русского описания GET ${path}`,
  );
  const operation = structuredClone(methods.get);
  operation.summary = text.summary;
  operation.description = text.description;
  operation.tags = operation.tags.map((tag) => {
    assert(russian.tags[tag], `Нет перевода раздела ${tag}`);
    usedTags.add(tag);
    return russian.tags[tag];
  });
  delete operation.requestBody;
  for (const parameter of operation.parameters ?? []) {
    let description = parameterDescriptions[parameter.name];
    if (parameter.name === "id") description = idDescriptions[path];
    if (parameter.name === "battleId")
      description = path.startsWith("/api/bosses/")
        ? "Идентификатор существующего боя с боссом, например из activeBattle в данных босса."
        : "Идентификатор боя между игроками из /api/combat. Идентификатор боя с боссом здесь не подходит.";
    if (path === "/api/friends/search" && parameter.name === "query")
      description =
        "Числовой идентификатор игрока или имя Telegram с @, например @username. Пробелы не допускаются.";
    if (path === "/api/bosses/invitations" && parameter.name === "direction") {
      description =
        "Для входящих приглашений укажите incoming. Это значение использует игровой клиент.";
      parameter.example = "incoming";
    }
    if (path === "/api/bosses/invitations" && parameter.name === "status") {
      description =
        "Для приглашений, ожидающих ответа, укажите pending. Это значение использует игровой клиент.";
      parameter.example = "pending";
    }
    if (
      path === "/api/achievements/{category}" &&
      parameter.name === "category"
    )
      description =
        "Ключ категории: combat — бои между игроками, boss — боссы, tasks — задания, stash — наборы, mutagen — мутагены, clothing — одежда, weapon — оружие, pets — питомцы, bag — сумка, general — общие, floor — этажи.";
    if (path === "/api/clans/search" && parameter.name === "query")
      description = "Строка поиска клана длиной от 2 до 24 символов.";
    if (path === "/api/notifications" && parameter.name === "category")
      description =
        "Ключ категории уведомлений. Оставьте выключенным для просмотра всех категорий.";
    assert(
      description,
      `Нет описания параметра ${parameter.name} в GET ${path}`,
    );
    parameter.description = description;
    if (parameter.schema) localizeSchemas(parameter.schema);
  }
  const observedSuccess = Object.entries(operation.responses).some(
    ([status, response]) =>
      status.startsWith("2") &&
      response["x-evidence"] === "network-response-shape",
  );
  if (!observedSuccess)
    operation.description +=
      "\n\nТочная структура успешного ответа для этого метода пока не подтверждена.";
  for (const [status, response] of Object.entries(operation.responses)) {
    if (status.startsWith("2")) response.description = text.response;
    else if (status === "400")
      response.description =
        "Некорректные параметры запроса. Проверьте обязательные поля, длину строки и допустимые значения.";
    else if (status === "404")
      response.description =
        "Запрошенный объект не найден или недоступен текущему аккаунту. Проверьте идентификатор.";
    else
      response.description =
        "Ошибка запроса или отказ в доступе. Проверьте токен, параметры и доступность объекта текущему аккаунту.";
    for (const content of Object.values(response.content ?? {}))
      if (content.schema) localizeSchemas(content.schema);
  }
  result.paths[path] = { get: operation };
  count++;
}
assert.equal(
  count,
  Object.keys(russian.operations).length,
  "В переводах есть лишние или пропущенные методы",
);
result.tags = Object.entries(russian.tags)
  .filter(([tag]) => usedTags.has(tag))
  .map(([, name]) => ({ name }));
for (const scheme of Object.values(result.components.securitySchemes ?? {}))
  scheme.description =
    "Access token текущего аккаунта. Вставьте только токен, без префикса Bearer.";
await writeFile(
  new URL("../public/api-docs/openapi.readonly.json", import.meta.url),
  await prettier.format(`${JSON.stringify(result, null, 2)}\n`, {
    parser: "json",
  }),
);

const swagger = structuredClone(source);
swagger.servers = [
  {
    url: "/",
    description: "API-прокси этого сайта",
  },
];
swagger.info.description =
  "Полный список REST-операций, найденных в доступном клиентском коде и сетевых наблюдениях. Это рабочая клиентская спецификация, а не подтверждённый серверный контракт. Изменяющие состояние запросы доступны из Swagger только после включения переключателя над списком.";
swagger.paths = {};
let swaggerCount = 0;
for (const [path, methods] of Object.entries(source.paths)) {
  const operations = {};
  for (const [method, sourceOperation] of Object.entries(methods)) {
    if (!httpMethods.has(method)) continue;
    const operation =
      method === "get" && result.paths[path]?.get
        ? structuredClone(result.paths[path].get)
        : structuredClone(sourceOperation);
    if (method !== "get") {
      operation["x-madhouse-mutation-gate"] =
        "X-Madhouse-Allow-Mutations: true";
      operation.description = [
        operation.description,
        "Изменяющий запрос. В Swagger он отправляется только при включённом переключателе над списком операций. Точная серверная валидация запроса независимо не подтверждена.",
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    operations[method] = operation;
    swaggerCount++;
  }
  if (Object.keys(operations).length) swagger.paths[path] = operations;
}
assert.equal(
  swaggerCount,
  Object.values(source.paths).reduce(
    (total, methods) =>
      total +
      Object.keys(methods).filter((method) => httpMethods.has(method)).length,
    0,
  ),
  "Swagger routes differ from the complete discovered operation inventory",
);
await writeFile(
  new URL("../public/api-docs/openapi.swagger.json", import.meta.url),
  await prettier.format(`${JSON.stringify(swagger, null, 2)}\n`, {
    parser: "json",
  }),
);
console.log(
  `Собраны спецификации: ${count} GET-методов только для чтения и ${swaggerCount} REST-операций Swagger в ${result.tags.length} разделах.`,
);
