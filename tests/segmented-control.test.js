import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

test("segmented control exposes a single selected radio and wraps keyboard navigation", async () => {
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
    const { SegmentedControl, nextSegmentedValue } = await server.ssrLoadModule(
      "/src/components/ui/SegmentedControl/SegmentedControl.jsx",
    );
    const options = [
      { value: "work", label: "Работа" },
      { value: "bosses", label: "Боссы" },
      { value: "businesses", label: "Бизнесы", disabled: true },
    ];
    const html = renderToStaticMarkup(
      React.createElement(SegmentedControl, {
        options,
        value: "work",
        onChange() {},
        label: "Категория этажа",
      }),
    );
    assert.match(html, /role="radiogroup" aria-label="Категория этажа"/);
    assert.equal((html.match(/aria-checked="true"/g) || []).length, 1);
    assert.match(html, /aria-checked="true"[^>]*tabindex="0"/);
    assert.equal(nextSegmentedValue(options, "work", "ArrowLeft"), "bosses");
    assert.equal(nextSegmentedValue(options, "bosses", "ArrowRight"), "work");
    assert.equal(nextSegmentedValue(options, "work", "End"), "bosses");
    assert.equal(nextSegmentedValue(options, "work", "Home"), "work");
    assert.equal(nextSegmentedValue(options, "work", "Enter"), "work");
  } finally {
    await server.close();
  }
});
