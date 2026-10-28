import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

test("bridge panel initially reports unknown status and does not expose setup prematurely", async () => {
  const vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [react()],
    server: { middlewareMode: true },
    appType: "custom",
  });
  try {
    const { BridgeConnection } = await vite.ssrLoadModule(
      "/src/features/auth/BridgeConnection/BridgeConnection.jsx",
    );
    const markup = renderToStaticMarkup(
      createElement(BridgeConnection, {
        client: {},
        createInstallCommand: () => "test",
      }),
    );
    assert.match(markup, /Мост устройства/);
    assert.match(markup, /Устройство:/);
    assert.match(markup, /Игровой токен:/);
    assert.doesNotMatch(markup, /Получить команду/);
    assert.doesNotMatch(markup, /test/);
  } finally {
    await vite.close();
  }
});
