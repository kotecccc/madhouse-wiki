import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

test("weapon durability is shown in the menu rather than on the card", async () => {
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
    const { InventoryItemCard, InventoryDurability, InventoryMenuDetails } =
      await server.ssrLoadModule(
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
    assert.doesNotMatch(html, /Остаток прочности оружия|Прочность: 27/);
    const menuDetails = renderToStaticMarkup(
      React.createElement(InventoryMenuDetails, {
        item: {
          ...item,
          equipped: true,
          installedMutagen: { name: "Мутаген A-17" },
        },
      }),
    );
    assert.match(menuDetails, /Мутаген A-17/);
    assert.match(menuDetails, /Уровень: 50 \/ 50/);
    const inactiveDetails = renderToStaticMarkup(
      React.createElement(InventoryMenuDetails, {
        item: {
          ...item,
          equipped: false,
          installedMutagen: { name: "Мутаген A-17" },
        },
      }),
    );
    assert.doesNotMatch(inactiveDetails, /Мутаген A-17/);
    const durability = renderToStaticMarkup(
      React.createElement(InventoryDurability, { item }),
    );
    assert.match(durability, /tabler-icon-tool/);
    assert.doesNotMatch(durability, /role="progressbar"/);
    assert.match(durability, /Прочность: 27 \/ 90/);
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
    assert.match(mutagen, /ui-pill--locked/);
    assert.match(mutagen, /tabler-icon-flask-filled/);
    assert.doesNotMatch(mutagen, /tabler-icon-flask-off/);
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
    assert.doesNotMatch(copy, /Прочность|role="progressbar"/);
    assert.doesNotMatch(html, /50 из 50 ур\./);
    assert.match(render({ ...item, ownedLevel: 12 }), /Ур\. 12/);
    assert.match(durability, /Прочность: 27 \/ 90/);
    assert.doesNotMatch(render({ ...item, ownedLevel: 0 }), /В гардеробе/);
    const equipped = render({ ...item, equipped: true });
    assert.match(
      equipped,
      /aria-label="Действия: Сабля" aria-haspopup="dialog" aria-expanded="false"/,
    );
    assert.match(equipped, /В руке/);
    assert.doesNotMatch(equipped, />Снять</);
    assert.doesNotMatch(html, />Надеть</);
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
    assert.match(
      renderToStaticMarkup(
        React.createElement(InventoryDurability, {
          item: { ...item, durability: 0 },
        }),
      ),
      /Прочность: 0 \/ 90/,
    );
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
      if (type !== "room") {
        assert.ok(
          owned.indexOf('class="inventory-item-stats"') >
            owned.indexOf('class="inventory-item-copy"'),
        );
        assert.doesNotMatch(owned, /inventory-item-details/);
      } else assert.match(owned, /inventory-item-details/);
      assert.match(
        owned,
        /role="button" tabindex="0" aria-label="Действия: Предмет" aria-haspopup="dialog" aria-expanded="false"/,
      );
      const buyable = render({
        type,
        status: "buyable",
        facts: { purchasePrice: { currency: "pills", amount: 25 } },
      });
      assert.match(
        buyable,
        /aria-label="Действия: Предмет" aria-haspopup="dialog" aria-expanded="false"/,
      );
      assert.doesNotMatch(buyable, /Купить · 25 пилюль/);
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
    const clothing = render({
      type: "clothing_item",
      installedMutagen: mutagen,
      equipped: false,
      mutagenActive: false,
    });
    assert.match(clothing, /Установлен: Мутаген A-17/);
    assert.doesNotMatch(clothing, /tabler-icon-flask-off|<s>/);
    assert.match(
      render({ type: "pet", installedMutagen: mutagen, equipped: false }),
      /<svg\b[^]*?<\/svg>A-17<\/span>/,
    );
    assert.match(
      render({ type: "pet", installedMutagen: mutagen, equipped: false }),
      /Неактивен: Мутаген A-17/,
    );
    assert.match(
      render({ type: "pet", installedMutagen: mutagen, equipped: false }),
      /ui-pill--locked/,
    );
    assert.match(
      render({ type: "pet", installedMutagen: mutagen, equipped: true }),
      /Установлен: Мутаген A-17/,
    );
    assert.match(
      render({ type: "pet", installedMutagen: mutagen, equipped: true }),
      /ui-pill--active/,
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
    assert.match(broken, /aria-label="Действия: Предмет"/);
    assert.match(broken, /Сломан/);
    assert.doesNotMatch(broken, /Починить \(50\)/);

    assert.match(broken, /Неактивен: Мутаген A-17/);
  } finally {
    await server.close();
  }
});
