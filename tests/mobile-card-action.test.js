import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

test("mobile card activation handles keyboard and ignores nested controls and dialogs", async () => {
  const server = await createServer({
    configFile: false,
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  try {
    const { mobileCardActionProps } = await server.ssrLoadModule(
      "/src/components/ui/BaseCard/useMobileCardAction.js",
    );
    let opened = 0;
    const props = mobileCardActionProps({
      label: "Открыть",
      onActivate: () => opened++,
    });
    const card = {};
    const text = { closest: () => card };
    props.onClick({ target: text, currentTarget: card });
    assert.equal(opened, 1);
    const nested = { closest: () => ({}) };
    props.onClick({ target: nested, currentTarget: card });
    props.onClick({
      target: text,
      currentTarget: card,
      defaultPrevented: true,
    });
    assert.equal(opened, 1);
    let prevented = 0;
    for (const key of ["Enter", " "]) {
      props.onKeyDown({
        target: card,
        currentTarget: card,
        key,
        preventDefault: () => prevented++,
      });
    }
    props.onKeyDown({ target: nested, currentTarget: card, key: "Enter" });
    assert.equal(opened, 3);
    assert.equal(prevented, 2);
    assert.equal(props.tabIndex, 0);
    assert.equal(props["aria-haspopup"], "dialog");
  } finally {
    await server.close();
  }
});
