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
        React.createElement(InventoryItemCard, { item: value }),
      );
    const html = render(item);
    assert.match(html, /aria-valuemax="90" aria-valuenow="27"/);
    assert.match(html, /Остаток прочности оружия/);
    const copy = html.slice(
      html.indexOf('class="inventory-item-copy"'),
      html.indexOf('class="inventory-item-status"'),
    );
    assert.match(copy, /50 из 50 ур\./);
    assert.match(copy, /role="progressbar"/);
    assert.match(html, /Прочность: 27 \/ 90/);
    assert.doesNotMatch(render({ ...item, ownedLevel: 0 }), /В гардеробе/);
    const equipped = render({ ...item, equipped: true });
    assert.match(equipped, /В руке/);
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
