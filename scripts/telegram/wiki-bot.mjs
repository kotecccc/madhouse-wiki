import { timingSafeEqual } from "node:crypto";
import { createBridgeInstallCommand } from "../../shared/bridge-install-command.js";
import {
  businessCardFilename,
  departmentCardFilename,
  floorCardFilename,
  inlineCardUrl,
  inlineCardsVersion,
  normalizeInlineCode,
  unavailableBusinessCardFilename,
} from "./inline-card-assets.mjs";
import {
  findItemBosses,
  getBusinessUpgradeTotals,
} from "../../src/lib/business-upgrades.js";

const TARGET_USERNAME = "madhouse_wiki_bot";
const DEFAULT_WIKI_ORIGIN = "https://madhouse-wiki.ru";
const TMA_URL = `https://t.me/${TARGET_USERNAME}?startapp=home`;
const START_IMAGE_PATH = "/madhouse-wiki-bot-start.png";
const MAX_WEBHOOK_BODY_BYTES = 96 * 1024;
const MAX_MESSAGE_LENGTH = 4096;
const INLINE_ANSWER_TIMEOUT_MS = 5000;
const RAID_FEED_TIMEOUT_MS = 1500;
const RAID_FEED_CACHE_MS = 10_000;
const ENERGY_TABLE_ROWS = [
  ["D-1", 688, 105, 66, 5, 330, "~4,8 дня"],
  ["E-1", 712, 145, 50, 15, 750, "~14,8 дня"],
  ["F-1", 876, 185, 47.5, 20, 950, "~24,3 дня"],
  ["G-1", 199, 185, 10.8, 15, 162, "~4,2 дня"],
  ["H-1", 434, 205, 21.2, 20, 424, "~12 дня"],
  ["I-1", 313, 260, 12, 25, 300, "~10,8 дня"],
  ["J-1", 319, 360, 8.9, 25, 222, "~11,1 дня"],
  ["K-1", 599, 400, 15, 30, 450, "~25 дня"],
  ["L-1", 2104, 440, 47.8, 6, 287, "~17,5 дня"],
  ["M-1", 852, 440, 19.4, 35, 678, "~41,4 дня"],
];
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

function inlineMarkup(sourceUrl = null, shareQuery = null) {
  const links = [];
  if (shareQuery) {
    links.push({ text: "↗ Поделиться", switch_inline_query: shareQuery });
  }
  if (sourceUrl) links.push({ text: "📄 Источник", url: sourceUrl });
  links.push({
    text: "📚 Madhouse Wiki",
    url: TMA_URL,
    style: "primary",
  });
  return { inline_keyboard: links.map((link) => [link]) };
}

function inlineArticle({
  id,
  title,
  description,
  message,
  sourceUrl,
  shareQuery = null,
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
    reply_markup: inlineMarkup(sourceUrl, shareQuery),
  };
}

function inlinePhoto({
  id,
  filename,
  title,
  description,
  caption,
  siteUrl,
  knowledgeBase,
  sourceUrl,
  shareQuery = null,
}) {
  const photoUrl = inlineCardUrl(
    siteUrl,
    filename,
    inlineCardsVersion(knowledgeBase),
  );
  return {
    type: "photo",
    id,
    photo_url: photoUrl,
    thumbnail_url: photoUrl,
    title: String(title || "Madhouse Wiki").slice(0, 128),
    description: String(description || "").slice(0, 256),
    caption: String(caption || "").slice(0, 1024),
    parse_mode: "HTML",
    reply_markup: inlineMarkup(sourceUrl, shareQuery),
  };
}

function fitHtmlLines(lines, maxLength = MAX_MESSAGE_LENGTH) {
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const nextLength = used + (kept.length ? 1 : 0) + line.length;
    if (nextLength > maxLength) break;
    kept.push(line);
    used = nextLength;
  }
  if (kept.length < lines.length) {
    while (kept.length && kept.join("\n").length + 2 > maxLength) kept.pop();
    kept.push("…");
  }
  return kept.join("\n");
}

function getDepartmentLocation(knowledgeBase, departmentId) {
  const department = knowledgeBase.departments.find(
    (candidate) => candidate.id === departmentId,
  );
  return department?.code || department?.blockCode || "—";
}

function getBusinessBossLines(knowledgeBase, upgrade, level) {
  const bosses = knowledgeBase.bosses || [];
  const rows = new Map();

  for (const item of getBusinessUpgradeTotals(upgrade, level)) {
    for (const boss of findItemBosses(bosses, item.entityId)) {
      if (item.requiredAmount === 0) continue;
      const row = rows.get(boss.id) || {
        boss,
        requiredAmount: 0,
        hasUnknownAmount: false,
      };
      if (item.requiredAmount == null) {
        row.hasUnknownAmount = true;
      } else {
        row.requiredAmount += item.requiredAmount;
      }
      rows.set(boss.id, row);
    }
  }

  return [...rows.values()].map(
    ({ boss, requiredAmount, hasUnknownAmount }) => {
      const amount = hasUnknownAmount
        ? "количество не указано"
        : `${formatNumber(requiredAmount)} предметов бизнеса`;
      return `${escapeHtml(boss.name || "Босс")} — отделение ${escapeHtml(getDepartmentLocation(knowledgeBase, boss.departmentId))} — ${amount}`;
    },
  );
}

function normalizeCode(value) {
  return value === "$" ? "$" : normalizeInlineCode(value);
}

function getRequestedCode(query) {
  const match =
    /(?:^|[\s,;])(?:этаж(?:а|е|и)?|корпус(?:а|е)?|отделени(?:е|я)|floor|department|energy|энерги(?:я|и)|бизнес(?:а|ы|е)?)?\s*(\$|[a-oс])\s*-?\s*([1-3])?(?=$|[\s,;])/iu.exec(
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
  const conditions = Array.isArray(floor.openingConditions)
    ? floor.openingConditions
    : [];
  return inlinePhoto({
    id: `floor-${normalizeCode(floor.code).replace(/[^A-Z0-9]/g, "x")}`,
    filename: floorCardFilename(floor.code),
    title: `🏢 Этаж ${floor.code}`,
    description: `${conditions.length} условий открытия этажа`,
    caption: `🏢 <b>Этаж ${escapeHtml(floor.code)}</b> • условия открытия.`,
    siteUrl,
    knowledgeBase,
    shareQuery: `этаж ${floor.code}`,
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
  if (!energy) {
    return inlinePhoto({
      id: `department-${normalizeCode(department.code).replace(/[^A-Z0-9]/g, "x")}`,
      filename: departmentCardFilename(department.code),
      title: `🏢 Отделение ${department.code}`,
      description: `${department.name || "Условия открытия отделения"} • ${conditions.length} условий`,
      caption: `🏢 <b>Отделение ${escapeHtml(department.code)}</b>${department.name ? ` • ${escapeHtml(department.name)}` : ""}.`,
      siteUrl,
      knowledgeBase,
      shareQuery: `отделение ${department.code}`,
    });
  }
  const lines = energy
    ? [
        `<b>⚡ ${escapeHtml(department.code)} • ${escapeHtml(department.name)}</b>`,
      ]
    : [
        `<b>🏢 ${escapeHtml(department.code)} • ${escapeHtml(department.name)}</b>`,
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
            ? `• ${label} • энергия по каталогу не рассчитана.`
            : `• ${label} — ${formatNumber(targetEnergy)} × ${formatNumber(count)} = <b>${formatNumber(energyTotal)} ⚡</b>.`,
        );
      } else {
        lines.push(`• ${label}`);
      }
    }
  } else {
    lines.push("", "<i>Условия открытия отделения в каталоге не указаны.</i>");
  }

  return inlineArticle({
    id: `${energy ? "energy" : "department"}-${normalizeCode(department.code).replace(/[^A-Z0-9]/g, "x")}`,
    title: `${energy ? "⚡ Энергия" : "🏢 Отделение"} ${department.code}`,
    description: department.work?.title || "Условия открытия отделения",
    message: fitHtmlLines(lines),
    siteUrl,
    shareQuery: `${energy ? "энергия" : "отделение"} ${department.code}`,
  });
}

function normalizeBusinessSearch(value) {
  return String(value || "")
    .normalize("NFKC")
    .replaceAll("ё", "е")
    .replaceAll("Ё", "Е")
    .trim()
    .toLocaleLowerCase("ru-RU");
}

function getBusinessQueryParts(query) {
  const prefix = /^\s*(?:бизнес(?:а|ы|е)?|business)\s*:?[ \t]*/iu;
  const term = String(query || "")
    .replace(prefix, "")
    .trim();
  const levelMatch = /(?:^|\s)(?:уров(?:ень|ня)\s*)?(\d+)\s*$/iu.exec(term);
  if (!levelMatch) return { name: term, level: null };
  return {
    name: term.slice(0, levelMatch.index).trim(),
    level: Number(levelMatch[1]),
  };
}

function getUpgradeLevels(upgrade) {
  const lengths = (upgrade?.items || [])
    .map((item) => (Array.isArray(item.levels) ? item.levels.length : 0))
    .filter((length) => length > 0);
  const maximum = lengths.length ? Math.min(...lengths) : 0;
  return Array.from({ length: maximum }, (_, index) => index + 1);
}

function describeBusinessLevel(
  knowledgeBase,
  business,
  upgrade,
  level,
  siteUrl,
) {
  const businessId = business.apiId || business.id;
  const departmentLocation = getDepartmentLocation(
    knowledgeBase,
    business.departmentId || upgrade.departmentId,
  );
  const captionParts = [
    `<b>${escapeHtml(departmentLocation)} • ${escapeHtml(business.title)} • Уровень ${level}</b>`,
    ...getBusinessBossLines(knowledgeBase, upgrade, level).map(
      (line, index) => `${index + 1}. ${line}`,
    ),
  ];
  return inlinePhoto({
    id: businessCardFilename(businessId, level).replace(/\.jpg$/u, ""),
    filename: businessCardFilename(businessId, level),
    title: `🏢 ${business.title} • уровень ${level}`,
    description: `${upgrade.items?.length || 0} типов предметов • пользовательская подборка`,
    caption: fitHtmlLines(captionParts, 1024),
    siteUrl,
    knowledgeBase,
    shareQuery: `бизнес ${business.title} ${level}`,
  });
}

function describeUnavailableBusiness(knowledgeBase, business, level, siteUrl) {
  const title = business?.title || "Бизнес не найден";
  const levelLabel = level == null ? "" : ` • уровень ${level}`;
  const businessId = business?.apiId || business?.id || "unknown";
  const resultId = businessCardFilename(businessId, level || 0)
    .replace(/^business-/u, "")
    .replace(/\.jpg$/u, "");
  return inlinePhoto({
    id: `business-unavailable-${resultId}`,
    filename: unavailableBusinessCardFilename,
    title: `🏢 ${title}${levelLabel}`,
    description: "В таблице нет подтверждённых требований для этого уровня",
    caption: `🏢 <b>${escapeHtml(title)}${escapeHtml(levelLabel)}</b> • требований к этому уровню в доступной таблице нет.`,
    siteUrl,
    knowledgeBase,
    shareQuery: level == null ? `бизнес ${title}` : `бизнес ${title} ${level}`,
  });
}

function getBusinessResults(knowledgeBase, query, siteUrl) {
  const { name, level } = getBusinessQueryParts(query);
  const businesses = knowledgeBase.businesses || [];
  const upgrades = knowledgeBase.businessUpgrades || [];
  if (!name) {
    const results = [];
    const seen = new Set();
    for (const upgrade of upgrades) {
      const business = businesses.find(
        (candidate) => candidate.id === upgrade.businessId,
      );
      if (!business || seen.has(business.id)) continue;
      seen.add(business.id);
      const firstLevel = getUpgradeLevels(upgrade)[0];
      if (firstLevel) {
        results.push(
          describeBusinessLevel(
            knowledgeBase,
            business,
            upgrade,
            firstLevel,
            siteUrl,
          ),
        );
      }
    }
    return results.slice(0, 50);
  }

  const wanted = normalizeBusinessSearch(name);
  const matches = businesses.filter((business) => {
    const title = normalizeBusinessSearch(business.title);
    return (
      title === wanted || title.startsWith(wanted) || title.includes(wanted)
    );
  });
  if (!matches.length) {
    return [
      inlineArticle({
        id: "business-not-found",
        title: "Бизнес не найден",
        description: "Проверьте название в каталоге",
        message: `Не нашёл бизнес «${escapeHtml(name)}». Пример: <code>@madhouse_wiki_bot бизнес Исследовательская 3</code>.`,
        siteUrl,
      }),
    ];
  }

  const results = [];
  for (const business of matches) {
    const upgrade = upgrades.find(
      (candidate) => candidate.businessId === business.id,
    );
    const levels = getUpgradeLevels(upgrade);
    if (!upgrade || !levels.length) {
      results.push(
        describeUnavailableBusiness(knowledgeBase, business, level, siteUrl),
      );
      continue;
    }
    const selectedLevels = level == null ? levels : [level];
    for (const targetLevel of selectedLevels) {
      if (!levels.includes(targetLevel)) {
        results.push(
          describeUnavailableBusiness(
            knowledgeBase,
            business,
            targetLevel,
            siteUrl,
          ),
        );
      } else {
        results.push(
          describeBusinessLevel(
            knowledgeBase,
            business,
            upgrade,
            targetLevel,
            siteUrl,
          ),
        );
      }
    }
  }
  return results.slice(0, 50);
}

function describeEnergyFloor(floor, knowledgeBase, siteUrl) {
  const departments = getDepartments(knowledgeBase, floor);
  const lines = [
    `<b>⚡ Энергия отделений • этаж ${escapeHtml(floor.code)}</b>`,
  ];
  let hasEnergyData = false;

  for (const department of departments) {
    const total = department.energyCycle?.full;
    const hasDepartmentEnergy = department.work && Number.isFinite(total);
    if (hasDepartmentEnergy) hasEnergyData = true;
    lines.push(
      "",
      `<b>${escapeHtml(department.code)} • ${escapeHtml(department.name)}</b>`,
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
      "<i>Для этого этажа в каталоге пока нет подтверждённого расчёта энергии.</i>",
    );
  }

  return inlineArticle({
    id: `energy-floor-${normalizeCode(floor.code).replace(/[^A-Z0-9]/g, "x")}`,
    title: `⚡ Этаж ${floor.code} • энергия`,
    description: departments.length
      ? `${departments.length} отделения • расход на полный цикл`
      : "Энергия в каталоге пока не указана",
    message: fitHtmlLines(lines),
    siteUrl,
    shareQuery: `энергия ${floor.code}`,
  });
}

function describeEnergyTable(siteUrl) {
  const tableRows = ENERGY_TABLE_ROWS.map(
    ([code, energy, limit, coupons, runs, total, duration]) => {
      const replenishments = [
        formatNumber(coupons),
        " × ",
        formatNumber(runs),
        " = ",
        formatNumber(total),
      ].join("");
      return [
        code.padEnd(5),
        formatNumber(energy).padStart(7),
        " ⚡  ",
        formatNumber(limit).padStart(4),
        " ⚡  ",
        replenishments.padEnd(20),
        "  ",
        duration,
      ].join("");
    },
  );
  const lines = [
    "<b>⚡ Энергия работ</b>",
    `<pre>Код   Проходка   Лимит   Купюры × раз = всего   Время\n${tableRows.join("\n")}</pre>`,
  ];
  return inlineArticle({
    id: "energy-table-snapshot",
    title: "⚡ Энергия • таблица проходок",
    description: "D-1—M-1 • купюры и примерное время",
    message: fitHtmlLines(lines),
    siteUrl,
    shareQuery: "энергия",
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
    `<i>Время указано в зоне ${escapeHtml(post?.timeZone || "не указано")}</i>`,
  ];

  for (const raid of raids.slice(0, 20)) {
    const details = [raid?.clan, raid?.boss].filter(Boolean).map(escapeHtml);
    const leader = raid?.leader ? ` • ведущий ${escapeHtml(raid.leader)}` : "";
    const duration = raid?.duration ? ` • ${escapeHtml(raid.duration)}` : "";
    lines.push(
      "",
      `<b>📍 ${escapeHtml(raid?.zone || "Зона не указана")} • ${escapeHtml(raid?.time || "время не указано")}</b>`,
      `${details.join(" • ") || "Детали рейда не указаны"}${leader}${duration}`,
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
      post?.sourceTitle || `🔥 Рейды • ${post?.raidDateLabel || "актуальные"}`,
    description: `${raids.length} рейдов • ${post?.timeZone || "время не указано"}`,
    message: fitHtmlLines(lines),
    siteUrl,
    sourceUrl,
    shareQuery: "рейды",
  });
}

function quickStartArticle(siteUrl) {
  return inlineArticle({
    id: "quick-start",
    title: "🔎 Поиск по справочнику",
    description: "Введите код этажа, отделения или название бизнеса",
    message: [
      "<b>Madhouse Wiki</b>",
      "В любом чате введите <code>@madhouse_wiki_bot C</code> для этажа, <code>@madhouse_wiki_bot C1</code> для отделения или <code>@madhouse_wiki_bot бизнес Исследовательская 3</code> для требований бизнеса.",
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
      const leftRank =
        floorRanks.get(left.floor?.id) ?? Number.MAX_SAFE_INTEGER;
      const rightRank =
        floorRanks.get(right.floor?.id) ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return String(left.sourceHeading).localeCompare(
        right.sourceHeading,
        "ru",
      );
    });

  const lines = ["<b>🏢 Этажи • условия открытия отделений по бизнесам</b>"];
  lines.push(
    ...sourceCaveats(
      knowledgeBase,
      unlocks.map((unlock) => unlock.sourceId),
    ).map((note) => `<i>${escapeHtml(note)}</i>`),
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
    title: "🏢 Бизнесы • все условия открытия",
    description: `${unlocks.length} связей из каталога Madhouse Wiki`,
    message: fitHtmlLines(lines),
    siteUrl,
    shareQuery: "этажи",
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
    "<i>Итог рассчитан по энергии полного цикла работ; лимит игрока и время восстановления не учитываются.</i>",
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
    lines.push(
      "",
      "В каталоге не найдено условий открытия через выполнение работ.",
    );
  }

  return inlineArticle({
    id: "opening-energy-all",
    title: "⚡ Энергия • открытие отделений",
    description: `${requirements.length} условий • итог по полным циклам работ`,
    message: fitHtmlLines(lines),
    siteUrl,
    shareQuery: "энергия",
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
    describeEnergyTable(siteUrl),
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
  bridgeDevices = null,
  bridgeReporter = null,
  bridgeBootstrapSha256 = "",
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
    if (
      method === "editMessageText" &&
      data?.error_code === 400 &&
      typeof data?.description === "string" &&
      data.description.toLowerCase().includes("message is not modified")
    )
      return true;
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
    } else if (/бизнес|business/.test(normalized)) {
      results = getBusinessResults(knowledgeBase, rawQuery, siteUrl);
    } else if (/этаж|корпус|отделени|услов|unlock/.test(normalized)) {
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

  async function sendPhoto(chatId, photo, caption, replyMarkup) {
    await callBotApi("sendPhoto", {
      chat_id: chatId,
      photo,
      caption,
      parse_mode: "HTML",
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  function startKeyboard(chatType) {
    const rows = [
      [{ text: "🏢 Этажи и отделения", callback_data: "menu:floors" }],
      [{ text: "🏬 Бизнес • требования", callback_data: "menu:business" }],
      [{ text: "⚡ Энергия работ", callback_data: "menu:energy" }],
      [{ text: "🔥 Актуальные рейды", callback_data: "menu:raids" }],
    ];
    if (chatType === "private" && bridgeDevices)
      rows.push([{ text: "🔌 Мост устройства", callback_data: "bridge:menu" }]);
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
              url: TMA_URL,
              style: "primary",
            },
          ],
    );
    return { inline_keyboard: rows };
  }

  function floorPicker(mode) {
    const isEnergy = mode === "energy";
    const floorButtons = knowledgeBase.floors.map((floor) => ({
      text: `-${floor.code}-`,
      callback_data: `${isEnergy ? "energyfloor" : "floor"}:${floor.code}`,
    }));
    const floorRows = [];
    for (let index = 0; index < floorButtons.length; index += 8) {
      floorRows.push(floorButtons.slice(index, index + 8));
    }
    return {
      inline_keyboard: [
        ...floorRows,
        ...(isEnergy
          ? [[{ text: "↩ Таблица энергии", callback_data: "menu:energy" }]]
          : []),
        [{ text: "↩ Главное меню", callback_data: "menu:home" }],
      ],
    };
  }

  function screenMarkup(shareQuery = null, extraRows = []) {
    const inlineKeyboard = [];
    if (shareQuery) {
      inlineKeyboard.push([
        { text: "↗ Поделиться карточкой", switch_inline_query: shareQuery },
      ]);
    }
    inlineKeyboard.push(...extraRows);
    inlineKeyboard.push([
      { text: "↩ Главное меню", callback_data: "menu:home" },
      { text: "📖 Madhouse Wiki", url: TMA_URL },
    ]);
    return { inline_keyboard: inlineKeyboard };
  }

  async function sendArticle(
    chatId,
    article,
    replyMarkup = article.reply_markup,
  ) {
    if (!article) {
      await sendMessage(chatId, "Раздел пока недоступен.", screenMarkup());
      return;
    }
    await sendMessage(
      chatId,
      article.input_message_content.message_text,
      replyMarkup,
    );
  }

  async function sendInlineResult(chatId, result, replyMarkup) {
    if (result?.type === "photo") {
      await sendPhoto(
        chatId,
        result.photo_url,
        result.caption,
        replyMarkup || result.reply_markup,
      );
      return;
    }
    await sendArticle(chatId, result, replyMarkup || result?.reply_markup);
  }

  async function handleCallback(callback) {
    const chatId = callback.message?.chat?.id;
    if (!chatId || typeof callback.data !== "string") return;
    await callBotApi("answerCallbackQuery", { callback_query_id: callback.id });

    if (callback.data.startsWith("bridge:")) {
      const sender = callback.from?.id;
      if (
        !bridgeDevices ||
        callback.message?.chat?.type !== "private" ||
        !Number.isSafeInteger(sender) ||
        sender < 1 ||
        sender !== chatId
      )
        return;
      const sendBridgeScreen = async (chatId, text, replyMarkup) => {
        if (callback.message.photo) {
          await sendMessage(chatId, text, replyMarkup);
          return;
        }
        await callBotApi("editMessageText", {
          chat_id: chatId,
          message_id: callback.message.message_id,
          text,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
      };
      const owner = String(sender);
      const device = bridgeDevices.list(owner);
      const menu = {
        inline_keyboard: [
          [
            { text: "🍎 Mac", callback_data: "bridge:mac" },
            { text: "📱 iPhone", callback_data: "bridge:iphone" },
          ],
          [{ text: "🔄 Проверить мост", callback_data: "bridge:check" }],
          ...(bridgeReporter
            ? [
                [
                  {
                    text: "📊 Включить сводку",
                    callback_data: "bridge:report",
                  },
                  { text: "🔕 Выключить", callback_data: "bridge:report-off" },
                ],
              ]
            : []),
          ...(device
            ? [
                [
                  {
                    text: "Отключить это устройство",
                    callback_data: `bridge:disconnect:${device.deviceId}`,
                  },
                ],
              ]
            : []),
          [{ text: "📖 Открыть Wiki", web_app: { url: siteUrl } }],
        ],
      };
      if (callback.data === "bridge:menu" || callback.data === "bridge:check") {
        const online =
          device && (await bridgeDevices.status(owner)) === "online";
        let reporting = false;
        if (online && callback.data === "bridge:check" && bridgeReporter)
          reporting = await bridgeReporter(owner, "auto").catch(() => false);
        await sendBridgeScreen(
          chatId,
          `<b>Мост устройства</b>\n${device ? (online ? "Устройство подключено." : "Устройство привязано, но мост не запущен.") : "Устройство ещё не подключено."}${reporting ? "\nСводка боёв включена." : ""}\n\nВыберите устройство для установки.`,
          menu,
        );
        return;
      }
      if (callback.data === "bridge:report") {
        const enabled =
          bridgeReporter && (await bridgeReporter(owner, "enable"));
        await sendBridgeScreen(
          chatId,
          enabled
            ? "Сводка включена. Во время боя здесь появится одно обновляемое сообщение; после серии в нём останется итог."
            : "Сначала подключите мост и игровой аккаунт в Wiki.",
          menu,
        );
        return;
      }
      if (callback.data === "bridge:report-off") {
        const disabled =
          bridgeReporter && (await bridgeReporter(owner, "disable"));
        await sendBridgeScreen(
          chatId,
          disabled
            ? "Сводка боёв выключена."
            : "Не удалось изменить настройки сводки. Попробуйте позже.",
          menu,
        );
        return;
      }
      if (callback.data.startsWith("bridge:disconnect:")) {
        const id = callback.data.slice("bridge:disconnect:".length);
        if (!device || id !== device.deviceId) {
          await sendBridgeScreen(
            chatId,
            "Устройство уже изменилось. Откройте меню моста заново.",
            menu,
          );
          return;
        }
        bridgeDevices.revoke(owner, id);
        await sendBridgeScreen(
          chatId,
          "Устройство отключено. Теперь выберите Mac или iPhone.",
          {
            inline_keyboard: [
              [{ text: "Выбрать устройство", callback_data: "bridge:menu" }],
            ],
          },
        );
        return;
      }
      if (!["bridge:mac", "bridge:iphone"].includes(callback.data)) return;
      if (device) {
        await sendBridgeScreen(
          chatId,
          "Уже привязано устройство. Чтобы подключить другое, сначала отключите его кнопкой ниже.",
          menu,
        );
        return;
      }
      const { invitation } = bridgeDevices.invite(owner);
      if (callback.data === "bridge:mac") {
        await sendBridgeScreen(
          chatId,
          `<b>Мост на Mac</b>\n1. Скачайте архив и распакуйте его.\n2. Нажмите правой кнопкой на файл моста → «Открыть».\n3. Вставьте одноразовый ключ: <code>${escapeHtml(invitation)}</code>\n\nКлюч действует 5 минут. Оставьте окно моста открытым.`,
          {
            inline_keyboard: [
              [
                {
                  text: "Скачать мост для Mac",
                  url: new URL(
                    "/bridge/MadhouseWikiBridge-macOS.zip",
                    siteUrl,
                  ).toString(),
                },
              ],
              [{ text: "Скопировать ключ", copy_text: { text: invitation } }],
              [{ text: "Проверить мост", callback_data: "bridge:check" }],
            ],
          },
        );
      } else {
        const command = createBridgeInstallCommand({
          invitation,
          bootstrapSha256: bridgeBootstrapSha256,
        });
        await sendBridgeScreen(
          chatId,
          `<b>Мост на iPhone</b>\n1. Установите iSH.\n2. Скопируйте команду ниже и вставьте её в iSH.\n3. Разрешите геолокацию, если iPhone спросит.\n\nКоманда действует 5 минут:\n<code>${escapeHtml(command)}</code>`,
          {
            inline_keyboard: [
              [{ text: "Проверить мост", callback_data: "bridge:check" }],
            ],
          },
        );
      }
      return;
    }

    if (callback.data === "menu:home") {
      await sendMessage(
        chatId,
        "<b>🕯 Madhouse Wiki</b>\nВыберите, что посмотреть:",
        startKeyboard(callback.message.chat.type),
      );
      return;
    }
    if (callback.data === "menu:floors") {
      await sendMessage(
        chatId,
        "<b>🏢 Этажи и отделения</b>\nВыберите этаж, чтобы посмотреть условия открытия и связанные отделения.",
        floorPicker("floors"),
      );
      return;
    }
    if (callback.data === "menu:business") {
      await sendMessage(
        chatId,
        "<b>🏬 Требования бизнеса</b>\nВведите название бизнеса и целевой уровень. Например: <code>бизнес Исследовательская 3</code>. Количества из пользовательской таблицы относятся к предметам, не к числу побед над боссами.",
        {
          inline_keyboard: [
            [
              {
                text: "🔎 Искать бизнес",
                switch_inline_query_current_chat: "бизнес ",
                style: "primary",
              },
            ],
            [{ text: "↩ Главное меню", callback_data: "menu:home" }],
          ],
        },
      );
      return;
    }
    if (callback.data === "menu:energy") {
      await sendMessage(
        chatId,
        describeEnergyTable(siteUrl).input_message_content.message_text,
        screenMarkup(null, [
          [
            {
              text: "📚 Энергия по этажам",
              callback_data: "menu:energyfloors",
            },
          ],
        ]),
      );
      return;
    }
    if (callback.data === "menu:energyfloors") {
      await sendMessage(
        chatId,
        "<b>⚡ Энергия по этажам</b>\nВыберите этаж для данных из каталога.",
        floorPicker("energy"),
      );
      return;
    }
    if (callback.data === "menu:raids") {
      await sendArticle(
        chatId,
        await readLatestRaidArticle(),
        screenMarkup("рейды"),
      );
      return;
    }

    const floorMatch = /^(floor|energyfloor):(.+)$/u.exec(callback.data);
    if (floorMatch) {
      const floor = knowledgeBase.floors.find(
        (candidate) =>
          normalizeCode(candidate.code) === normalizeCode(floorMatch[2]),
      );
      if (!floor) {
        await sendMessage(chatId, "Этаж не найден в каталоге.", screenMarkup());
        return;
      }
      const article =
        floorMatch[1] === "energyfloor"
          ? describeEnergyFloor(floor, knowledgeBase, siteUrl)
          : describeFloor(floor, knowledgeBase, siteUrl);
      const departments = getDepartments(knowledgeBase, floor);
      const departmentRows = departments.map((department) => [
        {
          text: `${floorMatch[1] === "energyfloor" ? "⚡" : "🏥"} ${department.code} • ${department.name}`.slice(
            0,
            64,
          ),
          callback_data: `department:${floorMatch[1] === "energyfloor" ? "energy:" : ""}${department.code}`,
        },
      ]);
      await sendInlineResult(
        chatId,
        article,
        screenMarkup(
          `${floorMatch[1] === "energyfloor" ? "энергия" : "этаж"} ${floor.code}`,
          departmentRows,
        ),
      );
      return;
    }

    const departmentMatch = /^department:(energy:)?(.+)$/u.exec(callback.data);
    if (departmentMatch) {
      const department = knowledgeBase.departments.find(
        (candidate) =>
          normalizeCode(candidate.code) === normalizeCode(departmentMatch[2]),
      );
      if (!department) {
        await sendMessage(
          chatId,
          "Отделение не найдено в каталоге.",
          screenMarkup(),
        );
        return;
      }
      const energy = Boolean(departmentMatch[1]);
      const article = describeDepartment(
        department,
        knowledgeBase,
        siteUrl,
        energy,
      );
      await sendInlineResult(
        chatId,
        article,
        screenMarkup(`${energy ? "энергия" : "отделение"} ${department.code}`),
      );
    }
  }

  async function handleMessage(message) {
    if (typeof message?.text !== "string" || !message.chat?.id) return;
    const command = message.text
      .trim()
      .split(/\s+/, 1)[0]
      .split("@")[0]
      .toLocaleLowerCase("en-US");
    const chatId = message.chat.id;

    if (command === "/bridge") {
      if (
        !bridgeDevices ||
        message.chat.type !== "private" ||
        !Number.isSafeInteger(message.from?.id) ||
        message.from.id !== chatId
      ) {
        await sendMessage(
          chatId,
          "Для подключения моста откройте личный чат с ботом.",
        );
        return;
      }
      await sendMessage(
        chatId,
        "<b>Мост устройства</b>\nОткройте меню, чтобы выбрать устройство или проверить подключение.",
        {
          inline_keyboard: [
            [{ text: "Открыть меню моста", callback_data: "bridge:menu" }],
          ],
        },
      );
      return;
    }

    if (command === "/start") {
      await sendPhoto(
        chatId,
        new URL(START_IMAGE_PATH, siteUrl).toString(),
        "<b>🕯 Madhouse Wiki</b>\nСправочник по этажам, отделениям, энергии работ и актуальным рейдам.\n\nВыберите раздел — карточки можно отправить в другие чаты прямо с экрана.",
        startKeyboard(message.chat.type),
      );
      return;
    }

    if (command === "/help") {
      await sendMessage(
        chatId,
        [
          "<b>Как пользоваться Madhouse Wiki</b>",
          "Выберите раздел в меню бота. В карточке нажмите <b>↗ Поделиться карточкой</b>, чтобы отправить её в другой чат.",
          "Или найдите карточку прямо в переписке: <code>@madhouse_wiki_bot C</code> — этаж, <code>@madhouse_wiki_bot C1</code> или <code>@madhouse_wiki_bot этаж С1</code> — отделение, <code>@madhouse_wiki_bot бизнес Исследовательская 3</code> — требования бизнеса.",
        ].join("\n\n"),
        startKeyboard(message.chat.type),
      );
      return;
    }

    if (command === "/business") {
      await sendMessage(
        chatId,
        "<b>🏬 Требования бизнеса</b>\nВведите название бизнеса и целевой уровень, например <code>бизнес Исследовательская 3</code>.",
        {
          inline_keyboard: [
            [
              {
                text: "🔎 Искать бизнес",
                switch_inline_query_current_chat: "бизнес ",
                style: "primary",
              },
            ],
            [{ text: "↩ Главное меню", callback_data: "menu:home" }],
          ],
        },
      );
      return;
    }

    if (["/floors", "/energy"].includes(command)) {
      await sendMessage(
        chatId,
        command === "/floors"
          ? "<b>🏢 Этажи и отделения</b>\nВыберите этаж, чтобы посмотреть условия открытия."
          : describeEnergyTable(siteUrl).input_message_content.message_text,
        command === "/floors"
          ? floorPicker("floors")
          : screenMarkup(null, [
              [
                {
                  text: "📚 Энергия по этажам",
                  callback_data: "menu:energyfloors",
                },
              ],
            ]),
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
      await sendMessage(
        chatId,
        article.input_message_content.message_text,
        screenMarkup("рейды"),
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
      } else if (update?.callback_query?.id) {
        await handleCallback(update.callback_query);
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
