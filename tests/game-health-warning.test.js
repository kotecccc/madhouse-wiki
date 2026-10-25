import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

test("game health warning keeps error details unmounted until requested", async () => {
  const server = await createServer({
    configFile: false,
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  try {
    const { reportGameHealth } = await server.ssrLoadModule(
      "/shared/session-api.js",
    );
    const { GameHealthWarning, GameHealthDetails, formatLastSuccess } =
      await server.ssrLoadModule(
        "/src/components/layout/BottomDock/GameHealthWarning.jsx",
      );
    for (const status of ["unavailable", "credentials_invalid"]) {
      reportGameHealth({ status });
      const html = renderToStaticMarkup(createElement(GameHealthWarning));
      assert.match(html, /aria-haspopup="dialog"/);
      assert.match(html, /base-card--glass-nav/);
      assert.match(html, /button-nav-tab/);
      assert.doesNotMatch(
        html,
        /<dialog\b|Последнее успешное обновление|Успешных обновлений/,
      );
    }
    for (const status of ["available", "unknown"]) {
      reportGameHealth({ status });
      assert.equal(renderToStaticMarkup(createElement(GameHealthWarning)), "");
    }
    const details = (status) =>
      renderToStaticMarkup(
        createElement(GameHealthDetails, {
          health: { status, lastSuccessAt: null },
        }),
      );
    const unavailable = details("unavailable");
    assert.match(unavailable, /Игровой сервер не отвечает/);
    assert.doesNotMatch(
      unavailable,
      /Wiki продолжает работать|О сохранённых данных|Последнее успешное обновление/,
    );
    const invalid = details("credentials_invalid");
    assert.match(invalid, /Требуется повторный вход/);
    assert.doesNotMatch(invalid, /Игровой сервер не отвечает/);
    assert.equal(
      formatLastSuccess(new Date(2026, 9, 25, 14, 51).getTime()),
      "14:51 25.10.2026",
    );
    assert.equal(formatLastSuccess(null), "—");
  } finally {
    await server.close();
  }
});
