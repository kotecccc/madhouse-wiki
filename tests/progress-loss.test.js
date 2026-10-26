import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import {
  nextProgressLoss,
  progressLossSegment,
  finishProgressLoss,
} from "../src/components/ui/ProgressBar/progress-loss.js";
const snapshot = (value, patch = {}) => ({
  value,
  max: 100,
  segments: 1,
  key: "fight-1",
  enabled: true,
  ...patch,
});

test("initial health has no damage trail; a decrease marks exactly the lost interval", () => {
  assert.equal(nextProgressLoss(null, snapshot(80), null, 1), null);
  const loss = nextProgressLoss(snapshot(80), snapshot(60), null, 2);
  assert.deepEqual(loss, { from: 80, to: 60, id: 2 });
  assert.deepEqual(progressLossSegment(loss, 0, 100), { left: 60, width: 20 });
});

test("quick successive hits retain the outstanding trail and stale completion cannot erase the latest hit", () => {
  const first = nextProgressLoss(snapshot(80), snapshot(60), null, 1);
  const next = nextProgressLoss(snapshot(60), snapshot(40), first, 2);
  assert.deepEqual(next, { from: 80, to: 40, id: 2 });
  assert.equal(finishProgressLoss(next, 1), next);
  assert.equal(finishProgressLoss(next, 2), null);
  assert.equal(nextProgressLoss(snapshot(40), snapshot(40), next, 3), next);
});

test("healing, a new battle, changed maximum, unavailable data or reduced motion clear damage without a fake hit", () => {
  const active = { from: 90, to: 40, id: 1 };
  for (const current of [
    snapshot(50),
    snapshot(20, { key: "fight-2" }),
    snapshot(20, { max: 200 }),
    snapshot(20, { enabled: false }),
    snapshot(20, { segments: 2 }),
  ])
    assert.equal(nextProgressLoss(snapshot(40), current, active, 2), null);
  assert.equal(
    nextProgressLoss(snapshot(40, { enabled: false }), snapshot(20), null, 2),
    null,
  );
});

test("damage crossing segment boundaries stays inside each affected segment, including a lethal hit", () => {
  const loss = { from: 80, to: 40, id: 1 };
  assert.deepEqual(progressLossSegment(loss, 0, 50), { left: 80, width: 20 });
  assert.deepEqual(progressLossSegment(loss, 50, 50), { left: 0, width: 60 });
  assert.equal(progressLossSegment({ from: 30, to: 20 }, 50, 50), null);
  assert.deepEqual(progressLossSegment({ from: 100, to: 0 }, 0, 100), {
    left: 0,
    width: 100,
  });
  assert.equal(progressLossSegment(null, 0, 100), null);
});

test("animated and ordinary bars preserve native progress semantics without showing an initial damage effect", async () => {
  const server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  try {
    const { ProgressBar } = await server.ssrLoadModule(
      "/src/components/ui/ProgressBar/ProgressBar.jsx",
    );
    for (const animateLoss of [false, true]) {
      const html = renderToStaticMarkup(
        createElement(ProgressBar, {
          value: 60,
          max: 100,
          label: "HP",
          valueText: "60 / 100",
          segments: 2,
          animateLoss,
          animationKey: "fight-1",
        }),
      );
      assert.ok(html.includes('aria-valuenow="60"'));
      assert.ok(html.includes('aria-valuemax="100"'));
      assert.ok(html.includes('aria-valuetext="60 / 100"'));
      assert.equal((html.match(/<progress /g) || []).length, 2);
      assert.ok(!html.includes('class="ui-progress-bar-loss"'));
      assert.ok(html.includes("ui-progress-bar-segment-shell"));
    }
  } finally {
    await server.close();
  }
});
