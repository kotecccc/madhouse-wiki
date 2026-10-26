import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CatalogueStore } from "../scripts/catalogue/store.mjs";
import { readKnowledgeBase } from "../scripts/catalogue/query.mjs";

test("boss drops join canonical names and known public preview media", () => {
  const root = mkdtempSync(join(tmpdir(), "madhouse-boss-drop-media-"));
  const store = new CatalogueStore(
    root,
    join(root, "local-data", "madhouse.sqlite"),
  );
  try {
    store.capture("/api/clothing", 200, {
      catalog: {
        sets: [
          {
            id: 5,
            items: [{ id: 24, setId: 5, name: "Зомби", categoryId: 4 }],
          },
        ],
      },
    });
    store.capture("/api/weapons/7", 200, { id: 7, name: "Тесак", assetId: 70 });
    store.capture("/api/pets/8", 200, { id: 8, name: "Крот", assetId: 80 });
    store.capture("/api/mutagens/state?type=I", 200, {
      type: "I",
      mutagens: [{ id: 3, name: "Мутаген I-3", type: "I", level: 3 }],
    });
    store.capture("/api/mutagens/state?type=A", 200, {
      type: "A",
      mutagens: [
        {
          id: 142,
          name: "Мутаген A-S",
          type: "A",
          level: null,
          rank: "Special",
        },
      ],
    });
    store.capture("/api/stash/sets", 200, {
      sets: [
        {
          setId: 53,
          ingredients: [
            {
              ingredientId: 4,
              imageUrl:
                "https://cdn.cargohustle.online/stash/composite/53/4.webp",
            },
          ],
        },
      ],
    });
    store.capture("/api/ornaments/zones/1", 200, {
      items: [{ id: 50, name: "Мёртвая плоть", setId: 5, zoneId: 1 }],
      zones: [],
    });
    store.capture("/api/rooms", 200, {
      catalog: { rooms: [{ id: 2, name: "Палата", asset: "17" }] },
    });
    store.capture("/api/bosses/1", 200, {
      id: 1,
      nameRu: "Босс",
      possibleDrops: [
        { type: "clothing_item", entityId: 24, name: "Зомби" },
        { type: "weapon", entityId: 7 },
        { type: "pet", entityId: 8 },
        { type: "mutagen", entityId: 3 },
        { type: "mutagen", entityId: 142 },
        { type: "room", entityId: 2 },
        { type: "ornament", setId: 5, entityId: 50 },
        { type: "stash_ingredient", setId: 53, entityId: 53004 },
        { type: "clothing_item", entityId: 999, name: "Без изображения" },
      ],
    });

    const model = readKnowledgeBase(root);
    assert.ok(
      model.inventoryItems.some(
        (item) => item.type === "room" && item.id === "2",
      ),
    );
    assert.ok(
      model.inventoryItems.some(
        (item) => item.type === "ornament" && item.zoneId === 1,
      ),
    );
    assert.ok(
      model.inventoryItems.every(
        (item) =>
          !Object.hasOwn(item, "owned") && !Object.hasOwn(item, "unlocked"),
      ),
    );
    const drops = model.bosses[0].possibleDrops;
    assert.equal(drops[0].name, "Зомби");
    assert.equal(drops[0].slotLabel, "Перчатки");
    assert.equal(
      drops[0].image,
      "https://cdn.cargohustle.online/customization/cloth/5/prew/24.webp",
    );
    assert.equal(
      drops[1].image,
      "https://cdn.cargohustle.online/customization/weapons/prew/7.webp",
    );
    assert.equal(
      drops[2].image,
      "https://cdn.cargohustle.online/customization/pet/prew/8.webp",
    );
    assert.equal(
      drops[3].image,
      "https://cdn.cargohustle.online/V3/mutogen/I/3.webp",
    );
    assert.equal(
      drops[4].image,
      "https://cdn.cargohustle.online/V3/mutogen/A/21.webp",
    );
    assert.equal(
      drops[5].image,
      "https://cdn.cargohustle.online/V3/room/statc/17.webp",
    );
    assert.equal(
      drops[6].image,
      "https://cdn.cargohustle.online/customization/ornament/5/P/Zone1.webp",
    );
    assert.equal(
      drops[7].image,
      "https://cdn.cargohustle.online/stash/composite/53/4.webp",
    );
    assert.equal(drops[8].image, null);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
