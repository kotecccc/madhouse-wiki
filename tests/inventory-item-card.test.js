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
      /Установлен: Мутаген A-17/,
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
