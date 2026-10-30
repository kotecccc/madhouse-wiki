import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { cataloguePlugin } from "../scripts/catalogue/vite-plugin.mjs";
import { CatalogueStore } from "../scripts/catalogue/store.mjs";

test("raid and boss queue statuses show readable reasons without internal codes", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "raid-notices-"));
  const store = new CatalogueStore(fixtureRoot);
  store.close();
  const server = await createServer({
    configFile: false,
    plugins: [react(), cataloguePlugin(fixtureRoot)],
    server: { middlewareMode: true },
    appType: "custom",
  });
  try {
    const { raidQueueActionNotice } = await server.ssrLoadModule(
      "/src/features/raids/RaidScheduleSection/RaidScheduleSection.jsx",
    );
    const { bossAutomationQueueNotice } = await server.ssrLoadModule(
      "/src/features/bosses/BossCard/BossCardView.jsx",
    );
    const raidNotice = raidQueueActionNotice({
      type: "invitation.accept",
      status: "waiting",
      blockedBy: "game",
      reason: "game_outage_wait",
    });
    const bossNotice = bossAutomationQueueNotice({
      type: "raid.start",
      status: "waiting",
      blockedBy: "rate",
      reason: "rate_limit_wait",
    });
    assert.equal(raidNotice, "Ожидает восстановления доступа к игре.");
    assert.equal(bossNotice, "Ожидает окончания ограничения частоты запросов.");
    assert.doesNotMatch(raidNotice, /game_outage_wait/);
    assert.doesNotMatch(bossNotice, /rate_limit_wait/);
    assert.equal(
      raidQueueActionNotice({
        type: "subscription.start",
        status: "waiting",
        reason: "Ожидаем приглашение от ведущего.",
      }),
      "Ожидаем приглашение от ведущего.",
    );
    assert.equal(
      bossAutomationQueueNotice({ type: "auto.start", status: "reconciling" }),
      "Проверяем результат последнего шага автоматизации.",
    );
  } finally {
    await server.close();
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
