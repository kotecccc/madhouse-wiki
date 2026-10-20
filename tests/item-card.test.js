import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

test("weapon and pet loot cards show base bonuses without cooldowns or per-level rows", async () => {
  const server = await createServer({
    configFile: false,
    plugins: [react()],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true },
    appType: "custom",
  });
  try {
    const { ItemCard } = await server.ssrLoadModule(
      "/src/features/items/ItemCard/ItemCard.jsx",
    );
    for (const type of ["weapon", "pet"]) {
      const html = renderToStaticMarkup(
        createElement(ItemCard, {
          item: {
            type,
            name: "Проверка",
            facts: {
              stats: {
                baseDamage: 12,
                aggression: 3,
                attackCooldownSeconds: 4,
              },
              perLevelStats: {
                baseDamage: 2,
                attackCooldownReductionSeconds: 0.04,
              },
              purchasePrice: { amount: 20, currency: "gold" },
            },
          },
        }),
      );
      assert.match(html, /12/);
      assert.match(html, /\+3/);
      assert.match(html, /20 монет/);
      assert.doesNotMatch(html, /Интервал атак|За каждый уровень|\/ ур\./);
      assert.doesNotMatch(html, /aria-label="За каждый уровень"|>\+2<|0\.04/);
    }
  } finally {
    await server.close();
  }
});

test("other item types retain per-level and attack interval facts", async () => {
  const server = await createServer({
    configFile: false,
    plugins: [react()],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true },
    appType: "custom",
  });
  try {
    const { ItemCard } = await server.ssrLoadModule(
      "/src/features/items/ItemCard/ItemCard.jsx",
    );
    const html = renderToStaticMarkup(
      createElement(ItemCard, {
        item: {
          type: "clothing_item",
          facts: {
            stats: { attackCooldownSeconds: 4 },
            perLevelStats: { aggression: 2 },
          },
        },
      }),
    );
    assert.match(html, /Интервал атак/);
    assert.match(html, /За каждый уровень/);
    assert.match(html, /\/ ур\./);
  } finally {
    await server.close();
  }
});
