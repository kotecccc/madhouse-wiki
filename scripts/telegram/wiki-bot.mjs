import { timingSafeEqual } from "node:crypto";

const TARGET_USERNAME = "madhouse_wiki_bot";
const DEFAULT_WIKI_ORIGIN = "https://madhouse-wiki.vercel.app";
const MAX_WEBHOOK_BODY_BYTES = 96 * 1024;
const MAX_MESSAGE_LENGTH = 4096;
const INLINE_ANSWER_TIMEOUT_MS = 5000;
const RAID_FEED_TIMEOUT_MS = 1500;
const RAID_FEED_CACHE_MS = 10_000;
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
  "Content-Type": "text/plain; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const formatNumber = (value) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value);

function sourceCaveats(knowledgeBase, sourceIds) {
  const ids = new Set(sourceIds.filter(Boolean));
  const sources = (knowledgeBase.sources || []).filter((source) =>
    ids.has(source.id),
  );
  const caveats = [];
  if (
    sources.some(
      (source) =>
        source.kind === "user-provided" &&
        source.verification === "provided-by-user; not-api-verified",
    )
  ) {
    caveats.push(
      "Источник условий: пользовательская подборка; API-подтверждения нет.",
    );
  }
  return caveats;
}

function equalSecret(expected, supplied) {
  if (typeof expected !== "string" || typeof supplied !== "string")
    return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(supplied, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeOrigin(value) {
  try {
    const origin = new URL(value || DEFAULT_WIKI_ORIGIN);
    if (origin.protocol !== "https:") return DEFAULT_WIKI_ORIGIN;
    return origin.origin;
  } catch {
    return DEFAULT_WIKI_ORIGIN;
  }
}

function inlineMarkup(siteUrl, sourceUrl = null) {
  const links = [];
  if (sourceUrl) links.push({ text: "📄 Источник", url: sourceUrl });
  links.push({
    text: "📚 Madhouse Wiki",
    url: siteUrl,
    style: "primary",
  });
  return { inline_keyboard: [links] };
}

function inlineArticle({
  id,
  title,
  description,
  message,
  siteUrl,
  sourceUrl,
}) {
  const messageText = String(message || "");
  return {
    type: "article",
    id,
    title: String(title || "Madhouse Wiki").slice(0, 128),
    description: String(description || "").slice(0, 256),
    input_message_content: {
      message_text: messageText,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    },
    reply_markup: inlineMarkup(siteUrl, sourceUrl),
  };
}

function fitHtmlLines(lines) {
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const nextLength = used + (kept.length ? 1 : 0) + line.length;
    if (nextLength > MAX_MESSAGE_LENGTH) break;
    kept.push(line);
    used = nextLength;
  }
  if (kept.length < lines.length) {
    while (kept.length && kept.join("\n").length + 2 > MAX_MESSAGE_LENGTH)
      kept.pop();
    kept.push("…");
  }
  return kept.join("\n");
}

function normalizeCode(value) {
  return value === "$" ? "$" : String(value || "").toLocaleUpperCase("en-US");
}

function getRequestedCode(query) {
  const match =
    /(?:^|[\s,;])(?:этаж(?:а|е|и)?|корпус(?:а|е)?|отделени(?:е|я)|floor|department|energy|энерги(?:я|и)|бизнес(?:а|ы|е)?)?\s*(\$|[a-o])\s*-?\s*([1-3])?(?=$|[\s,;])/iu.exec(
      String(query || "").trim(),
    );
  if (!match) return null;
  return normalizeCode(match[1] + (match[2] || ""));
}

function getDepartments(knowledgeBase, floor) {
  const byId = new Map(
    knowledgeBase.departments.map((department) => [department.id, department]),
  );
  const ordered = (floor.departmentIds || [])
    .map((id) => byId.get(id))
    .filter(Boolean);
  if (ordered.length) {
    return ordered.sort((left, right) =>
      String(left.code || "").localeCompare(String(right.code || ""), "ru", {
        numeric: true,
      }),
    );
  }
  return knowledgeBase.departments
    .filter((department) => department.floorId === floor.id)
    .sort((left, right) =>
      String(left.code || "").localeCompare(String(right.code || ""), "ru", {
        numeric: true,
      }),
    );
}

function describeFloor(floor, knowledgeBase, siteUrl) {
  const departments = getDepartments(knowledgeBase, floor);
  const businesses = knowledgeBase.businesses || [];
  const departmentsById = new Map(
    knowledgeBase.departments.map((department) => [department.id, department]),
  );
  const lines = [
    `<b>🏢 Этаж ${escapeHtml(floor.code)} · отделения и условия открытия</b>`,
  ];
  const floorText = String(floor.openingConditionText || "").trim();
  if (floorText) lines.push(escapeHtml(floorText));

  const additionalConditions = (floor.openingConditions || []).filter(
    (condition) => {
      const label = String(condition.label || "").trim();
      return (
        label &&
        !floorText
          .toLocaleLowerCase("ru")
          .includes(label.toLocaleLowerCase("ru"))
      );
    },
  );
  if (additionalConditions.length) {
    lines.push("", "<b>Условия перехода на этаж</b>");
    lines.push(
      ...additionalConditions.map(
        (condition) => `• ${escapeHtml(condition.label)}`,
      ),
    );
  }

  if (!floorText && !additionalConditions.length) {
    lines.push("", "Условия перехода на этот этаж в каталоге не указаны.");
  }

  if (departments.length) {
    lines.push("", "<b>Отделения</b>");
    for (const department of departments) {
      const departmentBusinesses = businesses
        .filter((business) => business.departmentId === department.id)
        .map((business) => business.title)
        .filter(Boolean);
      const businessLine = departmentBusinesses.length
        ? ` · ${escapeHtml(departmentBusinesses.join(", "))}`
        : "";
      lines.push(
        "",
        `<b>${escapeHtml(department.code)} · ${escapeHtml(department.name)}${businessLine}</b>`,
      );

      const conditions = Array.isArray(department.openingConditions)
        ? department.openingConditions
        : [];
      if (conditions.length) {
        lines.push(
          ...conditions.map(
            (condition) =>
              `• ${escapeHtml(condition.label || "Условие не указано")}`,
          ),
        );
      } else {
        lines.push("• Условия открытия отделения в каталоге не указаны.");
      }
    }
  }

  const businessUnlocks = (knowledgeBase.businessUpgrades || []).flatMap(
    (upgrade) =>
      (upgrade.unlocks || [])
        .filter(
          (unlock) =>
            departmentsById.get(unlock.targetDepartmentId)?.floorId ===
            floor.id,
        )
        .map((unlock) => ({
          ...unlock,
          sourceId: upgrade.sourceId,
        })),
  );
  if (businessUnlocks.length) {
    lines.push("", "<b>Бизнесы · условия открытия отделений</b>");
    lines.push(
      ...sourceCaveats(
        knowledgeBase,
        businessUnlocks.map((unlock) => unlock.sourceId),
      ).map(escapeHtml),
    );
    for (const unlock of businessUnlocks) {
      if (unlock.sourceHeading)
        lines.push(`• ${escapeHtml(unlock.sourceHeading)}`);
    }
  }

  return inlineArticle({
    id: `floor-${normalizeCode(floor.code).replace(/[^A-Z0-9]/g, "x")}`,
    title: `🏢 Этаж ${floor.code} · условия`,
    description: floorText || "Бизнесы и условия открытия отделений",
    message: fitHtmlLines(lines),
    siteUrl,
  });
}

function describeDepartment(
  department,
  knowledgeBase,
  siteUrl,
  energy = false,
) {
  const floor = knowledgeBase.floors.find(
    (candidate) => candidate.id === department.floorId,
  );
  const conditions = Array.isArray(department.openingConditions)
    ? department.openingConditions
    : [];
  const lines = energy
    ? [
        `<b>⚡ ${escapeHtml(department.code)} · ${escapeHtml(department.name)}</b>`,
      ]
    : [
        `<b>🏢 ${escapeHtml(department.code)} · ${escapeHtml(department.name)}</b>`,
      ];
  if (floor) lines.push(`Этаж ${escapeHtml(floor.code)}`);

  const total = department.energyCycle?.full;
  if (energy) {
    lines.push(
      department.work && Number.isFinite(total)
        ? `${escapeHtml(department.work.title)} — <b>${formatNumber(total)} ⚡</b> за полный цикл.`
        : "Расход энергии на полный цикл в каталоге не указан.",
    );
  }

  if (conditions.length) {
    lines.push("", "<b>Условия открытия</b>");
    const departmentsById = new Map(
      knowledgeBase.departments.map((candidate) => [candidate.id, candidate]),
    );
    for (const condition of conditions) {
      const label = escapeHtml(condition.label || "Условие не указано");
      if (energy && condition.type === "work_completions") {
        const target = departmentsById.get(condition.targetDepartmentId);
        const targetEnergy = target?.energyCycle?.full;
        const count = Number(condition.required);
        const energyTotal =
          Number.isFinite(targetEnergy) && Number.isFinite(count) && count >= 0
            ? targetEnergy * count
            : null;
        lines.push(
          energyTotal == null
            ? `• ${label} · энергия по каталогу не рассчитана.`
            : `• ${label} — ${formatNumber(targetEnergy)} × ${formatNumber(count)} = <b>${formatNumber(energyTotal)} ⚡</b>.`,
        );
      } else {
        lines.push(`• ${label}`);
      }
    }
  } else {
    lines.push("", "Условия открытия отделения в каталоге не указаны.");
  }

  return inlineArticle({
    id: `${energy ? "energy" : "department"}-${normalizeCode(department.code).replace(/[^A-Z0-9]/g, "x")}`,
    title: `${energy ? "⚡ Энергия" : "🏢 Отделение"} ${department.code}`,
    description: department.work?.title || "Условия открытия отделения",
    message: fitHtmlLines(lines),
    siteUrl,
  });
}

function describeEnergyFloor(floor, knowledgeBase, siteUrl) {
  const departments = getDepartments(knowledgeBase, floor);
  const lines = [
    `<b>⚡ Энергия отделений · этаж ${escapeHtml(floor.code)}</b>`,
  ];
  let hasEnergyData = false;

  for (const department of departments) {
    const total = department.energyCycle?.full;
    const hasDepartmentEnergy = department.work && Number.isFinite(total);
    if (hasDepartmentEnergy) hasEnergyData = true;
    lines.push(
      "",
      `<b>${escapeHtml(department.code)} · ${escapeHtml(department.name)}</b>`,
    );
    if (hasDepartmentEnergy) {
      lines.push(
        `${escapeHtml(department.work.title)} — <b>${formatNumber(total)} ⚡</b> за полный цикл.`,
      );
    } else {
      lines.push("Расход энергии на полный цикл в каталоге не указан.");
    }

    const workRequirements = (department.openingConditions || []).filter(
      (condition) => condition.type === "work_completions",
    );
    for (const condition of workRequirements) {
      const target = knowledgeBase.departments.find(
        (candidate) => candidate.id === condition.targetDepartmentId,
      );
      const targetEnergy = target?.energyCycle?.full;
      const count = Number(condition.required);
      if (
        Number.isFinite(targetEnergy) &&
        Number.isFinite(count) &&
        count >= 0
      ) {
        hasEnergyData = true;
        lines.push(
          `Открытие: ${escapeHtml(condition.label || "условие не указано")} — ${formatNumber(targetEnergy)} × ${formatNumber(count)} = <b>${formatNumber(targetEnergy * count)} ⚡</b>.`,
        );
      } else {
        lines.push(
          `Открытие: ${escapeHtml(condition.label || "условие не указано")} — энергия по каталогу не рассчитана.`,
        );
      }
    }
  }

  if (!hasEnergyData) {
    lines.push(
      "",
      "Для этого этажа в каталоге пока нет подтверждённого расчёта энергии.",
    );
  }

  return inlineArticle({
    id: `energy-floor-${normalizeCode(floor.code).replace(/[^A-Z0-9]/g, "x")}`,
    title: `⚡ Этаж ${floor.code} · энергия`,
    description: departments.length
      ? `${departments.length} отделения · расход на полный цикл`
      : "Энергия в каталоге пока не указана",
    message: fitHtmlLines(lines),
    siteUrl,
  });
}

function safeTelegramUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      ["t.me", "telegram.me"].includes(url.hostname)
    ) {
      return url.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function describeRaidPost(post, siteUrl) {
  const sourceUrl = safeTelegramUrl(post?.sourceUrl);
  const raids = Array.isArray(post?.raids) ? post.raids : [];
  const lines = [
    `<b>${escapeHtml(post?.sourceTitle || `🔥 РЕЙДЫ — ${post?.raidDateLabel || "дата не указана"}`)}</b>`,
    `Время: ${escapeHtml(post?.timeZone || "не указано")}`,
  ];

  for (const raid of raids.slice(0, 20)) {
    const details = [raid?.clan, raid?.boss].filter(Boolean).map(escapeHtml);
    const leader = raid?.leader ? ` · ведущий ${escapeHtml(raid.leader)}` : "";
    const duration = raid?.duration ? ` · ${escapeHtml(raid.duration)}` : "";
    lines.push(
      "",
      `<b>${escapeHtml(raid?.zone || "Зона не указана")} · ${escapeHtml(raid?.time || "время не указано")}</b>`,
      `${details.join(" · ") || "Детали рейда не указаны"}${leader}${duration}`,
    );
  }
  if (raids.length > 20)
    lines.push("", `Ещё рейдов в записи: ${formatNumber(raids.length - 20)}.`);
  if (sourceUrl)
    lines.push(
      "",
      `<a href="${escapeHtml(sourceUrl)}">Источник расписания</a>`,
    );

  return inlineArticle({
    id: `raids-${String(post?.raidDate || post?.sourceMessageId || "latest").replace(/[^a-zA-Z0-9_-]/g, "-")}`,
    title:
      post?.sourceTitle || `🔥 Рейды · ${post?.raidDateLabel || "актуальные"}`,
    description: `${raids.length} рейдов · ${post?.timeZone || "время не указано"}`,
    message: fitHtmlLines(lines),
    siteUrl,
    sourceUrl,
  });
}

function quickStartArticle(siteUrl) {
  return inlineArticle({
    id: "quick-start",
    title: "🔎 Поиск по справочнику",
    description: "Введите этаж, энергию или рейды",
    message: [
      "<b>Madhouse Wiki</b>",
      "В любом чате введите <code>@madhouse_wiki_bot этаж B</code>, <code>@madhouse_wiki_bot энергия A</code> или <code>@madhouse_wiki_bot рейды</code>.",
      "Выберите карточку — она отправится в чат.",
    ].join("\n\n"),
    siteUrl,
  });
}

function describeBusinessUnlocks(knowledgeBase, siteUrl) {
  const departments = new Map(
    knowledgeBase.departments.map((department) => [department.id, department]),
  );
  const floors = new Map(
    knowledgeBase.floors.map((floor) => [floor.id, floor]),
  );
  const floorRanks = new Map(
    knowledgeBase.floors.map((floor, index) => [floor.id, index]),
  );
  const unlocks = (knowledgeBase.businessUpgrades || [])
    .flatMap((upgrade) =>
      (upgrade.unlocks || []).map((unlock) => ({
        ...unlock,
        sourceId: upgrade.sourceId,
      })),
    )
    .filter((unlock) => unlock.sourceHeading)
    .map((unlock) => {
      const department = departments.get(unlock.targetDepartmentId);
      return {
        ...unlock,
        floor: floors.get(department?.floorId),
      };
    })
    .sort((left, right) => {
      const leftRank = floorRanks.get(left.floor?.id) ?? Number.MAX_SAFE_INTEGER;
      const rightRank =
        floorRanks.get(right.floor?.id) ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return String(left.sourceHeading).localeCompare(
        right.sourceHeading,
        "ru",
      );
    });

  const lines = ["<b>🏢 Этажи · условия открытия отделений по бизнесам</b>"];
  lines.push(
    ...sourceCaveats(
      knowledgeBase,
      unlocks.map((unlock) => unlock.sourceId),
    ).map(escapeHtml),
  );
  let previousFloor = null;
  for (const unlock of unlocks) {
    const floorCode = unlock.floor?.code;
    if (floorCode && floorCode !== previousFloor) {
      lines.push("", `<b>Этаж ${escapeHtml(floorCode)}</b>`);
      previousFloor = floorCode;
    }
    lines.push(`• ${escapeHtml(unlock.sourceHeading)}`);
  }
  if (!unlocks.length) {
    lines.push("", "Условия открытия бизнесов в каталоге не указаны.");
  }

  return inlineArticle({
    id: "business-unlocks-all",
    title: "🏢 Бизнесы · все условия открытия",
    description: `${unlocks.length} связей из каталога Madhouse Wiki`,
    message: fitHtmlLines(lines),
    siteUrl,
  });
}

function describeOpeningEnergy(knowledgeBase, siteUrl) {
  const departments = new Map(
    knowledgeBase.departments.map((department) => [department.id, department]),
  );
  const floors = new Map(
    knowledgeBase.floors.map((floor) => [floor.id, floor]),
  );
  const floorRanks = new Map(
    knowledgeBase.floors.map((floor, index) => [floor.id, index]),
  );
  const requirements = knowledgeBase.departments
    .flatMap((department) =>
      (department.openingConditions || [])
        .filter((condition) => condition.type === "work_completions")
        .map((condition) => ({ department, condition })),
    )
    .sort((left, right) => {
      const leftRank =
        floorRanks.get(left.department.floorId) ?? Number.MAX_SAFE_INTEGER;
      const rightRank =
        floorRanks.get(right.department.floorId) ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return String(left.department.code || "").localeCompare(
        String(right.department.code || ""),
        "ru",
        { numeric: true },
      );
    });

  const lines = [
    "<b>⚡ Энергия для открытия отделений</b>",
    "Итог рассчитан по энергии полного цикла работ; лимит игрока и время восстановления не учитываются.",
  ];
  let previousFloor = null;
  for (const { department, condition } of requirements) {
    const floorCode = floors.get(department.floorId)?.code;
    if (floorCode && floorCode !== previousFloor) {
      lines.push("", `<b>Этаж ${escapeHtml(floorCode)}</b>`);
      previousFloor = floorCode;
    }

    const target = departments.get(condition.targetDepartmentId);
    const fullCycleEnergy = target?.energyCycle?.full;
    const count = Number(condition.required);
    const label = escapeHtml(condition.label || "условие не указано");
    if (
      Number.isFinite(fullCycleEnergy) &&
      Number.isFinite(count) &&
      count >= 0
    ) {
      lines.push(
        `• Для <b>${escapeHtml(department.code)}</b>: ${label} — ${formatNumber(fullCycleEnergy)} ⚡/цикл × ${formatNumber(count)} = <b>${formatNumber(fullCycleEnergy * count)} ⚡</b>.`,
      );
    } else {
      lines.push(
        `• Для <b>${escapeHtml(department.code)}</b>: ${label} — энергия по каталогу не рассчитана.`,
      );
    }
  }

  if (!requirements.length) {
    lines.push("", "В каталоге не найдено условий открытия через выполнение работ.");
  }

  return inlineArticle({
    id: "opening-energy-all",
    title: "⚡ Энергия · открытие отделений",
    description: `${requirements.length} условий · итог по полным циклам работ`,
    message: fitHtmlLines(lines),
    siteUrl,
  });
}

function getFloorResults(knowledgeBase, query, siteUrl) {
  const requestedCode = getRequestedCode(query);
  if (requestedCode) {
    const department = knowledgeBase.departments.find(
      (candidate) => normalizeCode(candidate.code) === requestedCode,
    );
    if (department)
      return [describeDepartment(department, knowledgeBase, siteUrl)];

    const floor = knowledgeBase.floors.find(
      (candidate) => normalizeCode(candidate.code) === requestedCode,
    );
    return floor ? [describeFloor(floor, knowledgeBase, siteUrl)] : [];
  }
  return [
    describeBusinessUnlocks(knowledgeBase, siteUrl),
    ...knowledgeBase.floors.map((floor) =>
      describeFloor(floor, knowledgeBase, siteUrl),
    ),
  ];
}

function getEnergyResults(knowledgeBase, query, siteUrl) {
  const requestedCode = getRequestedCode(query);
  if (requestedCode) {
    const department = knowledgeBase.departments.find(
      (candidate) => normalizeCode(candidate.code) === requestedCode,
    );
    if (department) {
      return [describeDepartment(department, knowledgeBase, siteUrl, true)];
    }

    const floor = knowledgeBase.floors.find(
      (candidate) => normalizeCode(candidate.code) === requestedCode,
    );
    return floor ? [describeEnergyFloor(floor, knowledgeBase, siteUrl)] : [];
  }
  return [
    describeOpeningEnergy(knowledgeBase, siteUrl),
    ...knowledgeBase.floors.map((floor) =>
      describeEnergyFloor(floor, knowledgeBase, siteUrl),
    ),
  ];
}

function response(status, body) {
  return new Response(body, { status, headers: PRIVATE_HEADERS });
}

export function createWikiBotApi({
  token,
  webhookSecret,
  knowledgeBase,
  wikiOrigin,
  fetchImpl = globalThis.fetch,
} = {}) {
  const siteUrl = normalizeOrigin(wikiOrigin);
  const raidFeedUrl = new URL("/api/raids", siteUrl).toString();
  let raidFeedCache = { fetchedAt: 0, post: null };
  let raidFeedRequest = null;

  async function readLatestRaidPost() {
    if (Date.now() - raidFeedCache.fetchedAt < RAID_FEED_CACHE_MS) {
      return raidFeedCache.post;
    }
    if (raidFeedRequest) return raidFeedRequest;

    raidFeedRequest = (async () => {
      let post = null;
      try {
        const response = await fetchImpl(raidFeedUrl, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(RAID_FEED_TIMEOUT_MS),
        });
        if (response.ok) {
          const data = await response.json();
          const posts = Array.isArray(data?.posts) ? data.posts : [];
          post = posts[0] || null;
        }
      } catch {
        post = null;
      }
      raidFeedCache = { fetchedAt: Date.now(), post };
      raidFeedRequest = null;
      return post;
    })();

    return raidFeedRequest;
  }

  async function callBotApi(method, payload, timeoutMs = 10000) {
    if (!token) throw new Error("Bot API is not configured");
    const result = await fetchImpl(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    const data = await result.json().catch(() => null);
    if (!result.ok || data?.ok !== true) {
      throw new Error(`Telegram Bot API ${method} failed`);
    }
    return data.result;
  }

  async function answerInlineQuery(query) {
    const rawQuery = String(query.query || "").trim();
    const normalized = rawQuery.toLocaleLowerCase("ru-RU");
    let results = [];
    let cacheTime = 60;

    if (/рейд|raid|актуаль/.test(normalized)) {
      const post = await readLatestRaidPost();
      results = post
        ? [describeRaidPost(post, siteUrl)]
        : [
            inlineArticle({
              id: "raids-unavailable",
              title: "🔥 Актуальные рейды недоступны",
              description: "Источник расписания временно не ответил",
              message:
                "Расписание рейдов временно недоступно. Попробуйте позже или откройте справочник.",
              siteUrl,
            }),
          ];
      cacheTime = 10;
    } else if (/энерг|energy|проходк|затрат/.test(normalized)) {
      results = getEnergyResults(knowledgeBase, rawQuery, siteUrl);
    } else if (/этаж|корпус|отделени|бизнес|услов|unlock/.test(normalized)) {
      results = getFloorResults(knowledgeBase, rawQuery, siteUrl);
    } else if (rawQuery) {
      const departmentCode = getRequestedCode(rawQuery);
      if (departmentCode) {
        results = getFloorResults(knowledgeBase, rawQuery, siteUrl);
      }
    } else {
      results = [
        quickStartArticle(siteUrl),
        ...getFloorResults(knowledgeBase, "этажи", siteUrl).slice(0, 2),
        ...getEnergyResults(knowledgeBase, "энергия", siteUrl).slice(0, 1),
      ];
    }

    if (!results.length) results = [quickStartArticle(siteUrl)];
    await callBotApi(
      "answerInlineQuery",
      {
        inline_query_id: query.id,
        results: results.slice(0, 50),
        cache_time: cacheTime,
        is_personal: false,
      },
      INLINE_ANSWER_TIMEOUT_MS,
    );
  }

  async function readLatestRaidArticle() {
    const post = await readLatestRaidPost();
    return post ? describeRaidPost(post, siteUrl) : null;
  }

  async function sendMessage(chatId, text, replyMarkup) {
    await callBotApi("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  function startKeyboard(chatType) {
    const rows = [
      [
        {
          text: "🏢 Этажи",
          switch_inline_query: "этажи",
          style: "primary",
        },
        { text: "⚡ Энергия", switch_inline_query: "энергия" },
      ],
      [{ text: "🔥 Актуальные рейды", switch_inline_query: "рейды" }],
    ];
    rows.push(
      chatType === "private"
        ? [
            {
              text: "📖 Открыть Madhouse Wiki",
              web_app: { url: siteUrl },
              style: "primary",
            },
          ]
        : [
            {
              text: "📖 Открыть Madhouse Wiki",
              url: siteUrl,
              style: "primary",
            },
          ],
    );
    return { inline_keyboard: rows };
  }

  async function handleMessage(message) {
    if (typeof message?.text !== "string" || !message.chat?.id) return;
    const command = message.text
      .trim()
      .split(/\s+/, 1)[0]
      .split("@")[0]
      .toLocaleLowerCase("en-US");
    const chatId = message.chat.id;

    if (command === "/start") {
      await sendMessage(
        chatId,
        [
          "🕯 <b>Madhouse Wiki</b>",
          "Справочник по этажам, отделениям, энергии работ и актуальным рейдам.",
          "\nЧтобы переслать карточку в общеигровой чат, нажмите кнопку ниже или введите в чате <code>@madhouse_wiki_bot этаж B</code>, <code>@madhouse_wiki_bot энергия A</code> или <code>@madhouse_wiki_bot рейды</code>.",
        ].join("\n\n"),
        startKeyboard(message.chat.type),
      );
      return;
    }

    if (command === "/help") {
      await sendMessage(
        chatId,
        [
          "<b>Как поделиться карточкой</b>",
          "В любом чате начните ввод с <code>@madhouse_wiki_bot</code> и добавьте запрос:",
          "• <code>этаж B</code> — отделения и условия открытия",
          "• <code>энергия A</code> — энергия полного цикла и затраты на работу для открытия",
          "• <code>рейды</code> — актуальное расписание",
          "Выберите карточку из списка — она отправится в чат.",
        ].join("\n\n"),
        startKeyboard(message.chat.type),
      );
      return;
    }

    if (["/floors", "/energy"].includes(command)) {
      const query = command === "/floors" ? "этажи" : "энергия";
      await sendMessage(
        chatId,
        command === "/floors"
          ? "Выберите этаж в inline-списке. Для точного поиска можно ввести <code>этаж B</code> или <code>отделение B1</code>."
          : "Энергия указана за полный цикл работ. Например: <code>энергия A</code> или <code>энергия A2</code>.",
        {
          inline_keyboard: [
            [
              {
                text:
                  command === "/floors" ? "🏢 Найти этаж" : "⚡ Найти энергию",
                switch_inline_query: query,
                style: "primary",
              },
            ],
          ],
        },
      );
      return;
    }

    if (command === "/raids") {
      const article = await readLatestRaidArticle();
      if (!article) {
        await sendMessage(
          chatId,
          "Актуальное расписание рейдов временно недоступно. Попробуйте позже.",
          {
            inline_keyboard: [
              [
                {
                  text: "🔄 Открыть поиск рейдов",
                  switch_inline_query: "рейды",
                  style: "primary",
                },
              ],
            ],
          },
        );
        return;
      }
      const keyboard = article.reply_markup;
      await sendMessage(
        chatId,
        article.input_message_content.message_text,
        keyboard,
      );
    }
  }

  return async function handleWikiBotRequest(request) {
    if (request.method !== "POST") {
      return response(405, "method_not_allowed");
    }
    if (!token || !webhookSecret || !knowledgeBase) {
      return response(503, "bot_not_configured");
    }
    if (
      !equalSecret(
        webhookSecret,
        request.headers.get("x-telegram-bot-api-secret-token"),
      )
    ) {
      return response(403, "forbidden");
    }

    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > MAX_WEBHOOK_BODY_BYTES) {
      return response(413, "payload_too_large");
    }

    let update;
    try {
      update = JSON.parse(body);
    } catch {
      return response(400, "invalid_json");
    }

    try {
      if (update?.inline_query?.id) {
        await answerInlineQuery(update.inline_query);
      } else if (update?.message) {
        await handleMessage(update.message);
      }
      return response(200, "ok");
    } catch {
      return response(502, "bot_api_unavailable");
    }
  };
}

export const wikiBotSettings = {
  username: TARGET_USERNAME,
  wikiOrigin: DEFAULT_WIKI_ORIGIN,
  webhookPath: "/api/telegram/bot-webhook",
};
