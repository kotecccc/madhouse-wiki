import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

test("weapon progress uses durability, never level, and disappears when durability is unknown", async () => {
  const server = await createServer({
    configFile: false,
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  try {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { InventoryItemCard } = await server.ssrLoadModule(
      "/src/features/inventory/InventoryItemCard.jsx",
    );
    const item = {
      type: "weapon",
      name: "Сабля",
      status: "owned",
      ownedLevel: 50,
      maxLevel: 50,
      durability: 27,
      durabilityMax: 90,
    };
    const render = (value) =>
      renderToStaticMarkup(
        React.createElement(InventoryItemCard, { item: value, onEquip() {} }),
      );
    const html = render(item);
    assert.match(html, /aria-valuemax="90" aria-valuenow="27"/);
    assert.match(html, /Остаток прочности оружия/);
    assert.match(
      render({
        ...item,
        installedMutagen: { type: "A", level: 17, name: "Мутаген A-17" },
      }),
      /Неактивен: Мутаген A-17/,
    );
    assert.doesNotMatch(html, /Установлен:/);
    const mutagen = render({
      ...item,
      installedMutagen: {
        type: "A",
        name: "Мутаген A-17",
        bonuses: { aggression: 95 },
      },
    });
    assert.match(mutagen, /Агрессия: \+95/);
    assert.match(mutagen, /ui-icon--mutagen-A/);
    assert.match(mutagen, /tabler-icon-flask-off/);
    assert.match(
      render({
        ...item,
        equipped: true,
        installedMutagen: { type: "A", name: "Мутаген A-17" },
      }),
      /Установлен: Мутаген A-17/,
    );
    assert.match(mutagen, /aria-haspopup="dialog"/);
    const copy = html.slice(
      html.indexOf('class="inventory-item-copy"'),
      html.indexOf('class="inventory-item-status"'),
    );
    assert.match(copy, /Прочность: 27 \/ 90/);
    assert.match(copy, /role="progressbar"/);
    assert.doesNotMatch(html, /50 из 50 ур\./);
    assert.match(render({ ...item, ownedLevel: 12 }), /Ур\. 12/);
    assert.match(html, /aria-valuetext="27 из 90"/);
    assert.doesNotMatch(render({ ...item, ownedLevel: 0 }), /В гардеробе/);
    const equipped = render({ ...item, equipped: true });
    assert.match(equipped, /В руке/);
    assert.match(equipped, /Снять/);
    assert.match(html, /Надеть/);
    assert.doesNotMatch(render({ ...item, status: "locked" }), /Надеть|Снять/);
    assert.match(equipped, /Максимум/);
    assert.ok(equipped.indexOf("В руке") < equipped.indexOf("Максимум"));
    assert.doesNotMatch(equipped, /· В руках/);
    assert.doesNotMatch(
      render({ ...item, durability: null }),
      /role="progressbar"/,
    );
    assert.doesNotMatch(
      render({ ...item, durabilityMax: null }),
      /role="progressbar"/,
    );
    assert.match(render({ ...item, durability: 0 }), /aria-valuenow="0"/);
  } finally {
    await server.close();
  }
});

test("all inventory categories share cards, show appropriate actions and mark inactive mutagens", async () => {
  const server = await createServer({
    configFile: false,
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  try {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { InventoryItemCard } = await server.ssrLoadModule(
      "/src/features/inventory/InventoryItemCard.jsx",
    );
    const render = (item) =>
      renderToStaticMarkup(
        React.createElement(InventoryItemCard, {
          item: {
            id: "1",
            name: "Предмет",
            status: "owned",
            facts: { stats: { aggression: 10 } },
            ...item,
          },
          onAction() {},
        }),
      );
    for (const type of ["clothing_item", "pet", "ornament", "room", "weapon"]) {
      const owned = render({ type });
      assert.match(owned, /inventory-item-card/);
      assert.match(
        owned,
        type === "pet" || type === "room" ? /Выбрать/ : /Надеть/,
      );
      const buyable = render({
        type,
        status: "buyable",
        facts: { purchasePrice: { currency: "pills", amount: 25 } },
      });
      assert.match(buyable, /Купить · 25 пилюль/);
      const locked = render({
        type,
        status: "locked",
        facts: { purchasePrice: { currency: "pills", amount: 25 } },
      });
      assert.match(locked, /base-card--locked/);
      assert.doesNotMatch(locked, /Купить|Надеть|Снять|Выбрать/);
    }
    assert.match(render({ type: "room" }), /image-card--landscape/);
    assert.match(
      render({ type: "clothing_item", slotLabel: "Маска" }),
      /Маска/,
    );
    assert.match(
      render({ type: "ornament", setName: "Набор тату" }),
      /Набор тату/,
    );
    const mutagen = {
      type: "A",
      name: "Мутаген A-17",
      bonuses: { aggression: 95 },
    };
    assert.match(
      render({ type: "pet", installedMutagen: mutagen, equipped: false }),
      /Неактивен: Мутаген A-17/,
    );
    assert.match(
      render({ type: "pet", installedMutagen: mutagen, equipped: false }),
      /tabler-icon-flask-off/,
    );
    assert.match(
      render({ type: "pet", installedMutagen: mutagen, equipped: true }),
      /Установлен: Мутаген A-17/,
    );
    const broken = render({
      type: "weapon",
      isBroken: true,
      equipped: true,
      repairCost: 50,
      durability: 0,
      durabilityMax: 90,
      installedMutagen: mutagen,
    });
    assert.match(broken, /Сломан/);
    assert.match(broken, /Починить \(50\)/);
    assert.match(broken, /tabler-icon-pill/);
    assert.ok(broken.indexOf("Починить") < broken.indexOf(">Снять<"));
    assert.match(broken, /Неактивен: Мутаген A-17/);
  } finally {
    await server.close();
  }
});
