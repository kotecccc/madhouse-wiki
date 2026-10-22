import test from "node:test";
import assert from "node:assert/strict";
import {
  BOSS_DISPLAY_FIELD_IDS,
  RAID_DISPLAY_FIELD_IDS,
  bossDisplayFields,
  composeDisplayFields,
  normalizeFieldSelection,
  raidDisplayFields,
  splitDisplayFieldRows,
} from "./card-display-fields.js";

const values = (fields) =>
  Object.fromEntries(fields.map(({ id, value }) => [id, value]));

test("boss fields retain stable IDs, preserve the full block code, and format ranges", () => {
  const fields = bossDisplayFields(
    {
      name: "Охранник",
      requiredLevel: 12,
      rewardUntilLevel: 18,
      maxHp: 4500,
      damageMin: 40,
      damageMax: 80,
    },
    { code: "B2", floorCode: "B" },
  );

  assert.deepEqual(
    fields.map(({ id }) => id),
    BOSS_DISPLAY_FIELD_IDS,
  );
  assert.deepEqual(values(fields), {
    name: "Охранник",
    block: "B2",
    floor: "Этаж B",
    accessLevel: "Уровень 12–18",
    hp: "HP 4 500",
    damage: "DMG 40–80",
    drop: "",
  });
});

test("boss fields handle missing data and one-sided access ranges", () => {
  const oneSided = values(
    bossDisplayFields({ requiredLevel: 7 }, { blockCode: "C3" }),
  );
  assert.equal(oneSided.block, "C3");
  assert.equal(oneSided.floor, "Этаж C");
  assert.equal(oneSided.accessLevel, "Уровень от 7");
  assert.equal(oneSided.hp, "");
  assert.equal(oneSided.damage, "");

  const missing = values(bossDisplayFields());
  assert.equal(missing.accessLevel, "Уровень не указан");
  assert.equal(missing.name, "");
});

test("raid fields extend boss fields and use the passed display zone", () => {
  const fields = raidDisplayFields(
    {
      zone: "▶ A1",
      time: "20:30",
      duration: "2 ч",
      leader: "Аня",
      clan: "Лисы",
    },
    { name: "Босс" },
    { code: "A1" },
    "A1",
  );
  assert.deepEqual(
    fields.map(({ id }) => id),
    RAID_DISPLAY_FIELD_IDS,
  );
  assert.equal(values(fields).zone, "Зона A1");
  assert.equal(values(fields).time, "Время: 20:30");
  assert.equal(values(fields).duration, "Длительность: 2 ч");
  assert.equal(values(fields).leader, "Ведущий: Аня");
  assert.equal(values(fields).clan, "Клан: [Лисы]");
  assert.equal(
    values(raidDisplayFields({}, {}, {}, "")).time,
    "Время: не указано",
  );
});

test("composition follows requested order, deduplicates, and skips unknown or empty fields", () => {
  const fields = bossDisplayFields({ name: "Босс", maxHp: 0 });
  assert.equal(
    composeDisplayFields(fields, ["hp", "name", "missing", "name", "damage"]),
    "HP 0 • Босс",
  );
});

test("display rows follow selected order and ignore missing or leading breaks", () => {
  const fields = [
    { id: "a", label: "A", value: "Alpha" },
    { id: "empty", label: "Empty", value: " " },
    { id: "b", label: "B", value: "Beta" },
    { id: "c", label: "C", value: "Gamma" },
  ];
  assert.deepEqual(splitDisplayFieldRows(fields, ["a", "missing", "a"]), [
    [fields[0]],
  ]);
  assert.deepEqual(
    splitDisplayFieldRows(fields, ["a", "empty", "b", "c"], ["a", "b"]),
    [[fields[0]], [fields[2], fields[3]]],
  );
  assert.deepEqual(splitDisplayFieldRows(fields, ["c", "a", "b"], ["a", "b"]), [
    [fields[3]],
    [fields[0]],
    [fields[2]],
  ]);
});

test("field selections are bounded, unique, and preserve intentional empty arrays", () => {
  assert.deepEqual(normalizeFieldSelection([]), []);
  assert.deepEqual(
    normalizeFieldSelection(
      ["name", "name", "x-1", "bad id", "__proto__", 2],
      ["name", "x-1"],
    ),
    ["name", "x-1"],
  );
  assert.equal(
    normalizeFieldSelection("name", BOSS_DISPLAY_FIELD_IDS),
    undefined,
  );
  assert.equal(
    normalizeFieldSelection(Array.from({ length: 40 }, (_, i) => `x${i}`))
      .length,
    32,
  );
});

test("the single drop field combines rewardPreview currencies and distinguishes zero from unknown", () => {
  const fields = bossDisplayFields({
    rewardPreview: { gold: 1500, pills: 2, dollar: 0 },
    surrenderDollarCost: 99,
  });
  assert.equal(
    composeDisplayFields(fields, ["drop"]),
    "Монеты: 1 500 • Пилюли: 2 • Купюры: 0",
  );
  assert.equal(fields.filter(({ id }) => id === "drop").length, 1);
  const unknown = values(
    bossDisplayFields({
      rewardPreview: { gold: null, pills: -1, dollar: "12" },
      surrenderDollarCost: 99,
      wallet: { gold: 999 },
    }),
  );
  assert.equal(unknown.drop, "");
  assert.equal(values(bossDisplayFields()).drop, "");
});

test("legacy currency IDs migrate to one drop at the first selected position", () => {
  const fields = raidDisplayFields(
    { time: "20:00" },
    { name: "Босс", rewardPreview: { gold: 500, pills: 1, dollar: 3 } },
  );
  assert.equal(
    composeDisplayFields(fields, ["banknotes", "time", "drop", "pills"]),
    "Монеты: 500 • Пилюли: 1 • Купюры: 3 • Время: 20:00",
  );
  assert.deepEqual(
    normalizeFieldSelection(
      ["coins", "time", "drop", "pills", "banknotes"],
      RAID_DISPLAY_FIELD_IDS,
    ),
    ["drop", "time"],
  );
});
