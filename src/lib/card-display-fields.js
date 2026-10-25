import { fmt } from "./format.js";

/** Stable field IDs used by card editing and saved field selections. */
export const BOSS_DISPLAY_FIELD_IDS = Object.freeze([
  "name",
  "block",
  "floor",
  "accessLevel",
  "hp",
  "damage",
  "drop",
  "experience",
  "fightDuration",
  "participants",
]);

export const RAID_DISPLAY_FIELD_IDS = Object.freeze([
  ...BOSS_DISPLAY_FIELD_IDS,
  "zone",
  "time",
  "duration",
  "leader",
  "clan",
]);

const text = (value) =>
  value == null || String(value).trim() === "" ? "" : String(value).trim();

function accessLevelValue(boss) {
  const min = boss?.requiredLevel;
  const max = boss?.rewardUntilLevel;
  if (min != null && max != null) return `Уровень ${fmt(min)}–${fmt(max)}`;
  if (min != null) return `Уровень от ${fmt(min)}`;
  return "Уровень не указан";
}

function field(id, label, value) {
  return { id, label, value: text(value) };
}

function currencyReward(label, amount) {
  return typeof amount === "number" && Number.isFinite(amount) && amount >= 0
    ? `${label}: ${fmt(amount)}`
    : "";
}

function fightDurationLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return [
    hours ? `${fmt(hours)} ч` : "",
    minutes ? `${fmt(minutes)} мин` : "",
    rest || (!hours && !minutes) ? `${fmt(rest)} с` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function bossDisplayFields(boss = {}, department = {}) {
  const code = text(department.code || department.blockCode || boss.blockCode);
  const floorCode = text(department.floorCode || code.match(/^[A-Z]/iu)?.[0]);
  const fightDuration = fightDurationLabel(boss.maxFightDurationSeconds);
  const damage =
    boss.damageMin != null && boss.damageMax != null
      ? `${fmt(boss.damageMin)}–${fmt(boss.damageMax)}`
      : "";

  return [
    field("name", "Имя", boss.name),
    field("block", "Блок этажа", code),
    field("floor", "Этаж", floorCode ? `Этаж ${floorCode}` : ""),
    field("accessLevel", "Уровень", accessLevelValue(boss)),
    field("hp", "HP", boss.maxHp == null ? "" : `HP ${fmt(boss.maxHp)}`),
    field("damage", "DMG", damage ? `DMG ${damage}` : ""),
    {
      ...field(
        "drop",
        "Дроп",
        [
          currencyReward("Монеты", boss.rewardPreview?.gold),
          currencyReward("Пилюли", boss.rewardPreview?.pills),
          currencyReward("Купюры", boss.rewardPreview?.dollar),
        ]
          .filter(Boolean)
          .join(" • "),
      ),
      rewards: [
        ["coin", "Монеты", boss.rewardPreview?.gold],
        ["pill", "Пилюли", boss.rewardPreview?.pills],
        ["banknote", "Купюры", boss.rewardPreview?.dollar],
      ].filter(
        ([, , amount]) =>
          typeof amount === "number" && Number.isFinite(amount) && amount >= 0,
      ),
    },
    field(
      "experience",
      "Опыт",
      currencyReward("Опыт", boss.rewardPreview?.exp),
    ),
    field(
      "fightDuration",
      "Длительность боя",
      fightDuration ? `Бой: ${fightDuration}` : "",
    ),
    field(
      "participants",
      "Участники",
      Number.isSafeInteger(boss.maxParticipants) && boss.maxParticipants > 0
        ? `Участников: до ${fmt(boss.maxParticipants)}`
        : "",
    ),
  ];
}

export function raidDisplayFields(
  raid = {},
  boss = {},
  department = {},
  displayZone = raid.zone,
) {
  const zone = text(displayZone);
  return [
    ...bossDisplayFields(boss, department),
    field("zone", "Зона", zone ? `Зона ${zone}` : ""),
    field("time", "Время", `Время: ${raid.time || "не указано"}`),
    field(
      "duration",
      "Длительность",
      `Длительность: ${raid.duration || "не указана"}`,
    ),
    field("leader", "Ведущий", `Ведущий: ${raid.leader || "—"}`),
    field("clan", "Клан", `Клан: ${raid.clan ? `[${raid.clan}]` : "—"}`),
  ];
}

export function selectedDisplayFields(fields, ids) {
  const byId = new Map(
    (Array.isArray(fields) ? fields : []).map((item) => [item?.id, item]),
  );
  const seen = new Set();
  return (Array.isArray(ids) ? ids : [])
    .map(migrateFieldId)
    .filter((id) => {
      if (typeof id !== "string" || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((id) => byId.get(id))
    .filter((item) => item && text(item.value));
}

export function splitDisplayFieldRows(fields, ids, breakBefore = []) {
  const breaks = new Set(Array.isArray(breakBefore) ? breakBefore : []);
  const rows = [];
  for (const item of selectedDisplayFields(fields, ids)) {
    if (breaks.has(item.id) && rows.at(-1)?.length) rows.push([]);
    if (!rows.length) rows.push([]);
    rows.at(-1).push(item);
  }
  return rows;
}

export function composeDisplayFields(fields, ids) {
  return selectedDisplayFields(fields, ids)
    .map((item) => item.value)
    .join(" • ");
}

export function normalizeFieldSelection(value, allowedIds) {
  if (!Array.isArray(value)) return undefined;
  const allowed = Array.isArray(allowedIds) ? new Set(allowedIds) : null;
  const result = [];
  const seen = new Set();
  for (const id of value) {
    const normalizedId = migrateFieldId(id);
    if (
      typeof id !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(id) ||
      seen.has(normalizedId) ||
      (allowed && !allowed.has(normalizedId))
    )
      continue;
    seen.add(normalizedId);
    result.push(normalizedId);
    if (result.length >= 32) break;
  }
  return result;
}

function migrateFieldId(id) {
  return ["coins", "pills", "banknotes"].includes(id) ? "drop" : id;
}
