import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { CatalogueStore } from "./store.mjs";

export const USER_UPGRADE_SOURCE = "user:business-upgrades:2026-10-20";
const sourceFile = "local-data/sources/user-business-upgrades-2026-10-20.md";
const normalize = (value) =>
  String(value).toLowerCase().replaceAll("ё", "е").replace(/\s+/g, " ").trim();
export const normalizeBlockCode = (value) =>
  value
    .toUpperCase()
    .replace(
      /[АВСЕНКМОРТХ]/g,
      (c) =>
        ({
          А: "A",
          В: "B",
          С: "C",
          Е: "E",
          Н: "H",
          К: "K",
          М: "M",
          О: "O",
          Р: "P",
          Т: "T",
          Х: "X",
        })[c],
    )
    .replaceAll("-", "");

export function parseUserUpgradeTables(markdown) {
  const groups = new Map();
  for (const section of markdown.split(/^## /m).slice(1)) {
    const heading = section.split("\n")[0];
    const match = heading.match(
      /^([A-ZА-Я]-\d).*?«([^»]+)».*?→ для открытия ([A-ZА-Я]-\d)(.*)$/u,
    );
    if (!match) throw new Error(`Unrecognized source heading: ${heading}`);
    const [, rawCode, title, rawTarget, characterLevelText] = match;
    const code = normalizeBlockCode(rawCode),
      targetCode = normalizeBlockCode(rawTarget);
    const rows = section
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .map((line) =>
        line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim()),
      );
    const names = rows[0]?.slice(1);
    if (!names?.length) throw new Error(`Missing table: ${heading}`);
    const prices = rows.filter((row) => /^\d+ ур$/.test(row[0]));
    const declared = rows.find((row) => row[0] === "ИТОГО");
    const key = `${code}:${normalize(title)}`;
    const record = groups.get(key) ?? {
      code,
      title,
      items: names.map((name) => ({ name, levels: [] })),
      sourceTotals: [],
      unlocks: [],
    };
    if (record.items.some((item, i) => item.name !== names[i]))
      throw new Error(`Different items: ${heading}`);
    const covered = prices.map((row) => Number(row[0].split(" ")[0]));
    for (const row of prices) {
      const level = Number(row[0].split(" ")[0]);
      record.items.forEach((item, i) => {
        const count = Number(row[i + 1]);
        if (!Number.isSafeInteger(count) || count < 0)
          throw new Error(`Invalid price: ${heading}`);
        if (item.levels[level - 1] != null && item.levels[level - 1] !== count)
          throw new Error(`Conflicting price: ${heading}`);
        item.levels[level - 1] = count;
      });
    }
    for (let i = 0; i < names.length; i++) {
      const computed = prices.reduce((sum, row) => sum + Number(row[i + 1]), 0);
      record.sourceTotals.push({
        firstLevel: Math.min(...covered),
        lastLevel: Math.max(...covered),
        itemName: names[i],
        declared: Number(declared[i + 1]),
        computed,
        matches: Number(declared[i + 1]) === computed,
      });
    }
    record.unlocks.push({
      targetCode,
      requiredLevel: Math.max(...covered),
      sourceHeading: heading,
      characterLevelText: characterLevelText.trim() || null,
    });
    groups.set(key, record);
  }
  return [...groups.values()];
}

export function importUserUpgrades(store, markdown) {
  const records = parseUserUpgradeTables(markdown);
  const source = USER_UPGRADE_SOURCE;
  store.db.exec("BEGIN");
  try {
    store.source(
      source,
      "user-provided",
      sourceFile,
      "provided-by-user; not-api-verified",
      "User explicitly authorized these reference definitions on 2026-10-20. Per-level amounts are authoritative for sums; source totals retained, including disagreements. Stated floor order also requires the previous floor's final department.",
    );
    store.db
      .prepare("INSERT OR REPLACE INTO source_documents VALUES (?,?,?)")
      .run(
        source,
        markdown,
        createHash("sha256").update(markdown).digest("hex"),
      );
    const rows = () =>
      store.db
        .prepare("SELECT * FROM entities")
        .all()
        .map((r) => ({
          ...JSON.parse(r.data_json),
          kind: r.kind,
          id: r.id,
          apiId: r.api_id,
          sourceId: r.source_id,
        }));
    const original = rows();
    const ensureDepartment = (code) => {
      const id = `dept-${code}`;
      if (
        !store.db
          .prepare("SELECT 1 FROM entities WHERE kind='department' AND id=?")
          .get(id)
      ) {
        store.entity(
          "department",
          id,
          { code, blockCode: code, floorId: `floor-${code[0]}` },
          source,
        );
        store.link(
          "department",
          id,
          "on_floor",
          "floor",
          `floor-${code[0]}`,
          source,
        );
      }
      return id;
    };
    const itemNames = new Map(
      original
        .filter((r) => r.kind === "activity_item")
        .map((i) => [String(i.itemId), i.name]),
    );
    const dropItems = original
      .filter((r) => r.kind === "boss")
      .flatMap((b) =>
        (b.possibleDrops ?? [])
          .filter((d) => d.type === "activity_item")
          .map((d) => ({
            ...d,
            name: itemNames.get(String(d.entityId)) ?? d.name,
            bossId: b.id,
          })),
      );
    const aliases = new Map([["Инквизитора печать", "Инквизиторская печать"]]);
    const addRequirement = (ownerKind, ownerId, key, value) => {
      const id = `${source}:${key}`;
      store.entity(
        "requirement",
        id,
        { ...value, sourceId: source, verification: "user-provided" },
        source,
      );
      store.link(ownerKind, ownerId, "supplements", "requirement", id, source);
      const kind = value.targetBusinessId ? "business" : "department";
      store.link(
        "requirement",
        id,
        "target",
        kind,
        value.targetBusinessId ?? value.targetDepartmentId,
        source,
      );
    };
    for (const record of records) {
      const departmentId = ensureDepartment(record.code);
      let business = original.find(
        (e) =>
          e.kind === "business" &&
          normalize(e.title ?? e.name) === normalize(record.title) &&
          (e.departmentId === departmentId ||
            store.db
              .prepare(
                "SELECT 1 FROM entity_links WHERE from_kind='business' AND from_id=? AND relation='in_department' AND to_id=?",
              )
              .get(e.id, departmentId)),
      );
      if (!business) {
        // An API unlock rule is evidence for this business ID, but the user owns its newly supplied definition.
        const apiRule = original.find(
          (e) =>
            e.kind === "requirement" &&
            e.type === "business_level" &&
            e.businessId != null &&
            normalize(e.label).includes(normalize(record.title)),
        );
        const id = apiRule
          ? `business:${apiRule.businessId}`
          : `business:user:${record.code}:${record.title}`;
        store.entity(
          "business",
          id,
          { title: record.title, departmentId },
          source,
          apiRule?.businessId ?? null,
        );
        business = { id };
      }
      store.link(
        "business",
        business.id,
        "in_department",
        "department",
        departmentId,
        source,
      );
      const items = record.items.map((item) => {
        const targetName = aliases.get(item.name) ?? item.name;
        const matches = [
          ...new Map(
            dropItems
              .filter((d) => normalize(d.name) === normalize(targetName))
              .map((d) => [String(d.entityId), d]),
          ).values(),
        ];
        if (matches.length !== 1)
          throw new Error(
            `Cannot uniquely map item ${item.name}: ${matches.length} IDs`,
          );
        return {
          entityId: matches[0].entityId,
          name: matches[0].name,
          sourceName: item.name,
          levels: Array.from(item.levels, (v) => v ?? null),
        };
      });
      const unlocks = record.unlocks.map((u) => ({
        targetDepartmentId: ensureDepartment(u.targetCode),
        requiredLevel: u.requiredLevel,
        sourceHeading: u.sourceHeading,
        characterLevelText: u.characterLevelText,
      }));
      const upgradeId = `business-upgrade:${business.id}`;
      store.entity(
        "business_upgrade",
        upgradeId,
        {
          businessId: business.id,
          departmentId,
          sourceId: source,
          source: "user-provided",
          note: "Counts are item requirements, not boss kills. Source totals retain any disagreement with the level rows. Инквизитора печать is mapped to API item Инквизиторская печать by its unique name variant; sourceName is retained.",
          items,
          sourceTotals: record.sourceTotals,
          unlocks,
        },
        source,
      );
      store.link(
        "business_upgrade",
        upgradeId,
        "for_business",
        "business",
        business.id,
        source,
      );
      for (const u of record.unlocks) {
        const ownerKind = u.targetCode.endsWith("1") ? "floor" : "department";
        const ownerId =
          ownerKind === "floor"
            ? `floor-${u.targetCode[0]}`
            : ensureDepartment(u.targetCode);
        addRequirement(ownerKind, ownerId, `${u.targetCode}:${business.id}`, {
          type: "business_level",
          targetBusinessId: business.id,
          requiredLevel: u.requiredLevel,
          label: `Иметь ${record.title} ${u.requiredLevel} уровня`,
        });
        const targetDepartmentId = ensureDepartment(u.targetCode);
        const prevCode = u.targetCode.endsWith("1")
          ? `${String.fromCharCode(u.targetCode.charCodeAt(0) - 1)}3`
          : `${u.targetCode[0]}${Number(u.targetCode[1]) - 1}`;
        ensureDepartment(prevCode);
        addRequirement(ownerKind, ownerId, `${u.targetCode}:previous`, {
          type: "department_open",
          targetDepartmentId: `dept-${prevCode}`,
          label: `Открыть отделение ${prevCode}`,
        });
        // Keep the target department identity even when the floor owns the visible rule.
        store.link(
          "business_upgrade",
          upgradeId,
          "opens_department",
          "department",
          targetDepartmentId,
          source,
        );
      }
    }
    store.db.exec("COMMIT");
    return {
      businesses: records.length,
      levels: records.reduce((sum, r) => sum + r.items[0].levels.length, 0),
      disagreements: records.flatMap((r) =>
        r.sourceTotals
          .filter((t) => !t.matches)
          .map((t) => ({ business: r.title, ...t })),
      ),
    };
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const root = resolve(new URL("../../", import.meta.url).pathname);
  const store = new CatalogueStore(root);
  try {
    console.log(
      JSON.stringify(
        importUserUpgrades(
          store,
          readFileSync(resolve(root, sourceFile), "utf8"),
        ),
        null,
        2,
      ),
    );
  } finally {
    store.close();
  }
}
