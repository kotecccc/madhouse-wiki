import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import {
  bossPreviewUrl,
  itemImageUrl,
  mutagenImageUrl,
} from "./public-assets.mjs";
import { PUBLIC_ASSETS_CDN } from "./public-assets.mjs";
import { itemFacts } from "./item-facts.mjs";

const text = (value) =>
  typeof value === "string" ? value : (value?.ru ?? value?.en ?? "");
const clothingSlotLabels = new Map([
  [2, "Брюки"],
  [3, "Торс"],
  [4, "Перчатки"],
  [5, "Обувь"],
  [6, "Цепь"],
  [8, "Маска"],
  [9, "Питомец"],
]);
export function readKnowledgeBase(
  root,
  file = process.env.MADHOUSE_CATALOGUE_DB ||
    resolve(root, "local-data/madhouse.sqlite"),
) {
  const db = new DatabaseSync(file, {
    readOnly: true,
  });
  try {
    const rows = db
      .prepare(
        "SELECT kind,id,api_id,data_json,source_id FROM entities ORDER BY kind,coalesce(json_extract(data_json,'$.number'),cast(api_id as integer)),id",
      )
      .all();
    const rewardPreviewCaptures = new Set(
      db
        .prepare(
          "SELECT key FROM metadata WHERE key LIKE 'boss_reward_preview:v1:%'",
        )
        .all()
        .map((row) => row.key.slice("boss_reward_preview:v1:".length)),
    );
    const links = db
      .prepare("SELECT * FROM entity_links ORDER BY ordinal,to_id")
      .all();
    const routeRows = db
      .prepare(
        "SELECT kind,id,floor_code,department_code,client_sha256 FROM route_discovery ORDER BY floor_code,department_code,kind,id",
      )
      .all();
    const all = rows.map((r) => ({
      ...JSON.parse(r.data_json),
      id: r.id,
      apiId: r.api_id,
      kind: r.kind,
      sourceId: r.source_id,
    }));
    const of = (kind) => all.filter((r) => r.kind === kind);
    const byId = Object.fromEntries(all.map((r) => [r.id, r]));
    const routeDepartments = new Map();
    const routeFloors = new Map();
    const routeMembership = new Map();
    for (const route of routeRows) {
      const floorId = `floor-${route.floor_code}`;
      const departmentId = `dept-${route.department_code}`;
      routeFloors.set(route.floor_code, {
        id: floorId,
        apiId: route.floor_code,
        code: route.floor_code,
        kind: "floor",
        metadataOnly: true,
        discovery: {
          source: "public-client-route",
          sha256: route.client_sha256,
        },
      });
      routeDepartments.set(route.department_code, {
        id: departmentId,
        apiId: route.department_code,
        code: route.department_code,
        blockCode: route.department_code,
        floorId,
        kind: "department",
        metadataOnly: true,
        discovery: {
          source: "public-client-route",
          sha256: route.client_sha256,
        },
      });
      routeMembership.set(`${route.kind}:${route.id}`, departmentId);
    }
    const apiDepartments = of("department");
    const apiDepartmentsByCode = new Map(
      apiDepartments.map((department) => [
        department.blockCode ?? department.code ?? department.apiId,
        department,
      ]),
    );
    const apiFloorByDepartment = new Map(
      links
        .filter(
          (link) =>
            link.from_kind === "department" &&
            link.relation === "on_floor" &&
            link.to_kind === "floor",
        )
        .map((link) => [link.from_id, link.to_id]),
    );
    const departmentsById = new Map(
      apiDepartments.map((department) => [
        department.id,
        {
          ...department,
          floorId:
            apiFloorByDepartment.get(department.id) ?? department.floorId,
        },
      ]),
    );
    for (const [code, discovered] of routeDepartments) {
      const apiDepartment = apiDepartmentsByCode.get(code);
      const department = apiDepartment
        ? {
            ...departmentsById.get(apiDepartment.id),
            // Route evidence owns membership; API definitions continue to own names and facts.
            floorId: discovered.floorId,
            discovery: discovered.discovery,
          }
        : discovered;
      department.code = department.blockCode ?? department.code ?? code;
      departmentsById.set(department.id, department);
      routeDepartments.set(code, department);
    }
    const departmentIdsByFloor = new Map();
    for (const department of departmentsById.values()) {
      if (!department.floorId) continue;
      const list = departmentIdsByFloor.get(department.floorId) ?? [];
      list.push(department.id);
      departmentIdsByFloor.set(department.floorId, list);
    }
    const activityItemNames = new Map(
      of("activity_item").map((item) => [String(item.itemId), item.name]),
    );
    const wardrobeItems = all
      .filter((entity) =>
        ["clothing_item", "weapon", "pet"].includes(entity.kind),
      )
      .map((entity) => {
        const unlock = entity.unlock;
        if (
          unlock?.required !== true ||
          unlock.conditionType !== "player_level"
        )
          return null;
        const requiredLevel =
          unlock.requiredLevel ??
          entity.requiredLevel ??
          unlock.conditionId ??
          null;
        if (!Number.isSafeInteger(requiredLevel) || requiredLevel < 1)
          return null;
        return {
          id: entity.id,
          apiId: entity.apiId,
          type: entity.kind,
          name: text(entity.name),
          requiredLevel,
          image: itemImageUrl(entity.apiId),
          slotLabel:
            entity.kind === "clothing_item"
              ? (clothingSlotLabels.get(Number(entity.categoryId)) ?? null)
              : null,
          facts: itemFacts(entity, entity.kind),
        };
      })
      .filter(Boolean);
    const stashSets = of("stash_set");
    const stashSetForRequirement = (r) => {
      if (r.type !== "stash_medallion" || typeof r.label !== "string")
        return null;
      const medallionName = r.label
        .replace(/^Собрать коллекцию\s*/i, "")
        .trim()
        .toLocaleLowerCase("ru");
      return (
        stashSets.find(
          (set) =>
            text(set.medallionReward?.name).trim().toLocaleLowerCase("ru") ===
            medallionName,
        ) || null
      );
    };
    const inDepartment = (row) =>
      routeMembership.get(`${row.kind}:${row.apiId}`) ??
      links.find(
        (l) =>
          l.from_kind === row.kind &&
          l.from_id === row.id &&
          l.relation === "in_department",
      )?.to_id ??
      null;
    const requirement = (r) => {
      const target = (kind, id) =>
        id == null
          ? null
          : all.find((e) => e.kind === kind && e.apiId === String(id));
      const stashSet = stashSetForRequirement(r);
      return {
        ...r,
        targetBossId: r.targetBossId ?? target("boss", r.bossId)?.id ?? null,
        targetBusinessId:
          r.targetBusinessId ?? target("business", r.businessId)?.id ?? null,
        targetDepartmentId:
          r.targetDepartmentId ?? inDepartment(target("work", r.workId) ?? {}),
        targetStashSetId: r.targetStashSetId ?? stashSet?.id ?? null,
      };
    };
    const conditions = (row) => {
      const seen = new Set();
      return links
        .filter(
          (l) =>
            l.from_kind === row.kind &&
            l.from_id === row.id &&
            ["requires", "supplements"].includes(l.relation),
        )
        .map((l) => byId[l.to_id])
        .filter(Boolean)
        .map(requirement)
        .filter((r) => {
          const key = JSON.stringify([
            r.type,
            r.targetBusinessId,
            r.targetBossId,
            r.targetDepartmentId,
            r.requiredLevel ?? r.required,
          ]);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort(
          (a, b) =>
            Number(b.type === "department_open") -
            Number(a.type === "department_open"),
        );
    };
    const works = of("work").map((w) => ({
      ...w,
      title: text(w.title),
      departmentId: inDepartment(w),
    }));
    const departments = [...departmentsById.values()].map((d) => {
      const w = works.find((w) => w.departmentId === d.id);
      const tasks = w?.tasks ?? [];
      const full =
        tasks.length &&
        tasks.every(
          (t) => Number.isFinite(t.energyCost) && Number.isFinite(t.required),
        )
          ? tasks.reduce((sum, t) => sum + t.energyCost * t.required, 0)
          : null;
      const stash = stashSets.find(
        (s) => String(s.setId) === String(w?.stashSetId),
      );
      // Reference asset paths identify their floor and department slot even
      // when the work definition has not been captured. Keep that preview
      // separate from work data; it must not create a synthetic work entity.
      const code = d.blockCode ?? d.code;
      const [, floorCode, slot] = /^([A-O$])(\d+)$/.exec(code || "") || [];
      const preview =
        stash ||
        stashSets.find((set) => {
          if (!floorCode || !set.previewImageUrl) return false;
          try {
            return (
              new URL(set.previewImageUrl).pathname ===
              `/stash/${floorCode}/${slot}_1.webp`
            );
          } catch {
            return false;
          }
        });
      return {
        ...d,
        code,
        stashPreview: preview
          ? {
              id: preview.id,
              title: text(preview.name ?? preview.title),
              image: preview.previewImageUrl,
            }
          : null,
        openingConditions: conditions(d),
        work: w
          ? {
              ...w,
              stash: text(stash?.name ?? stash?.title),
              image: w.image ?? stash?.previewImageUrl,
            }
          : null,
        energyCycle: { full },
      };
    });
    const floors = [
      ...of("floor"),
      ...[...routeFloors.values()].filter(
        (routeFloor) =>
          !of("floor").some((floor) => floor.code === routeFloor.code),
      ),
    ].map((f) => ({
      ...f,
      departmentIds:
        departmentIdsByFloor.get(f.id) ??
        departments.filter((d) => d.floorId === f.id).map((d) => d.id),
      openingConditions: conditions(f),
      openingConditionText: f.unlockDescription ?? null,
    }));
    const mediaFor = (drop) => {
      const kindByDrop = {
        mutagen: "mutagen",
        room: "room",
        clothing_item: "clothing_item",
        weapon: "weapon",
        pet: "pet",
        stash_ingredient: "stash_ingredient",
        ornament: "ornament_element",
      };
      const kind = kindByDrop[drop.type];
      const identity = drop.itemId ?? drop.elementId ?? drop.entityId;
      const entity =
        kind &&
        all.find(
          (entry) =>
            entry.kind === kind &&
            (String(entry.apiId) === String(identity) ||
              (kind === "stash_ingredient" &&
                String(entry.setId) === String(drop.setId) &&
                (String(entry.ingredientId) === String(drop.ingredientId) ||
                  Number(identity) ===
                    Number(drop.setId) * 1000 + Number(entry.ingredientId))) ||
              String(entry.id).replace(`${kind}-`, "") === String(identity)),
        );
      const direct = [
        drop.previewUrl,
        drop.imageUrl,
        drop.iconUrl,
        entity?.previewUrl,
        entity?.previewImageUrl,
        entity?.imageUrl,
        entity?.iconUrl,
      ].find((url) => typeof url === "string" && url.trim());
      if (direct) return direct;
      if (drop.type === "clothing_item" && entity) {
        const setId = drop.setId ?? entity.setId;
        const itemId = entity.itemId ?? entity.apiId ?? entity.id;
        if (setId != null && itemId != null)
          return `${PUBLIC_ASSETS_CDN}/customization/cloth/${setId}/prew/${itemId}.webp`;
      }
      if (drop.type === "weapon" && entity) {
        const id =
          entity.assetId ?? entity.weaponId ?? entity.apiId ?? entity.id;
        if (id != null)
          return `${PUBLIC_ASSETS_CDN}/customization/weapons/prew/${id}.webp`;
      }
      if (drop.type === "pet" && entity) {
        const id = entity.assetId ?? entity.petId ?? entity.apiId ?? entity.id;
        if (id != null)
          return `${PUBLIC_ASSETS_CDN}/customization/pet/prew/${id}.webp`;
      }
      if (drop.type === "mutagen" && entity?.type) {
        const level = entity.level ?? (entity.rank === "Special" ? 21 : null);
        if (level != null) return mutagenImageUrl(entity.type, level);
      }
      if (drop.type === "room" && entity) {
        const asset = entity.asset ?? entity.apiId ?? entity.id;
        if (asset != null)
          return `${PUBLIC_ASSETS_CDN}/V3/room/statc/${asset}.webp`;
      }
      if (
        drop.type === "ornament" &&
        (drop.setId ?? entity?.setId) != null &&
        (drop.zoneId ?? entity?.zoneId) != null
      )
        return `${PUBLIC_ASSETS_CDN}/customization/ornament/${drop.setId ?? entity.setId}/P/Zone${drop.zoneId ?? entity.zoneId}.webp`;
      if (drop.type === "activity_item" && drop.entityId != null)
        return itemImageUrl(drop.entityId);
      return null;
    };
    const enrichedDrops = (boss) =>
      (boss.possibleDrops ?? []).map((drop) => {
        const kindByDrop = {
          mutagen: "mutagen",
          room: "room",
          clothing_item: "clothing_item",
          weapon: "weapon",
          pet: "pet",
          stash_ingredient: "stash_ingredient",
          ornament: "ornament_element",
          activity_item: "activity_item",
        };
        const kind = kindByDrop[drop.type];
        const identity = drop.itemId ?? drop.elementId ?? drop.entityId;
        const entity =
          kind &&
          all.find(
            (entry) =>
              entry.kind === kind &&
              (String(entry.apiId) === String(identity) ||
                (kind === "stash_ingredient" &&
                  String(entry.setId) === String(drop.setId) &&
                  (String(entry.ingredientId) === String(drop.ingredientId) ||
                    Number(identity) ===
                      Number(drop.setId) * 1000 +
                        Number(entry.ingredientId))) ||
                String(entry.id).replace(`${kind}-`, "") === String(identity)),
          );
        return {
          ...drop,
          name: drop.name || text(entity?.name) || drop.name,
          image: mediaFor(drop),
          facts: itemFacts(entity, kind),
          ...(drop.type === "mutagen"
            ? {
                mutagenType: entity?.type ?? null,
                mutagenLevel:
                  entity?.level ?? (entity?.rank === "Special" ? 21 : null),
              }
            : {}),
          ...(drop.type === "clothing_item"
            ? {
                categoryId: entity?.categoryId ?? null,
                slotLabel:
                  clothingSlotLabels.get(Number(entity?.categoryId)) ?? null,
              }
            : {}),
        };
      });
    return {
      schemaVersion: 2,
      floors,
      departments,
      works,
      bosses: of("boss").map((b) => ({
        ...b,
        numericId: Number(b.apiId),
        rewardPreviewCaptured:
          Object.hasOwn(b, "rewardPreview") ||
          rewardPreviewCaptures.has(String(b.apiId)),
        name: text(b.nameRu ?? b.name),
        departmentId: inDepartment(b),
        image: bossPreviewUrl(b.apiId),
        possibleDrops: enrichedDrops(b).map((drop) =>
          drop.type === "activity_item"
            ? {
                ...drop,
                name: activityItemNames.get(String(drop.entityId)) || drop.name,
              }
            : drop,
        ),
        // The API embeds activity-item drops in this boss record. Their entityId
        // is the item identifier used by the public client's /V3/items route.
        dropItems: (b.possibleDrops ?? [])
          .filter((drop) => drop.type === "activity_item")
          .map((drop) => ({
            ...drop,
            name:
              activityItemNames.get(String(drop.entityId)) ||
              text(drop.name) ||
              `Предмет бизнеса №${drop.entityId}`,
            image: itemImageUrl(drop.entityId),
          }))
          .filter((drop) => drop.image),
      })),
      businesses: of("business").map((b) => ({
        ...b,
        title: text(b.title ?? b.name),
        departmentId: inDepartment(b),
      })),
      wardrobeItems,
      stashSets,
      businessUpgrades: of("business_upgrade"),
      sources: db.prepare("SELECT * FROM sources").all(),
      coverage: db.prepare("SELECT * FROM captures ORDER BY path").all(),
      routeDiscovery: routeRows.length
        ? {
            source: "public-client-route",
            clientSha256: routeRows[0].client_sha256,
            entityMemberships: routeRows.length,
            floors: routeFloors.size,
            departments: routeDepartments.size,
          }
        : null,
    };
  } finally {
    db.close();
  }
}
