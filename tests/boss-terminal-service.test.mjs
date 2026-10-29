import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutomationService } from "../scripts/automation/service.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";

for (const result of ["timed_out", "lost", "active", "absent"]) {
  test(`server checks expired fight once and accepts confirmed result ${result}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "boss-terminal-service-"));
    const store = createAutomationStateStore({ directory });
    const calls = [];
    let now = 1_000_000;
    const rawBattle = (status) => ({
      battleId: "old-battle",
      bossId: 7,
      status,
      serverTimeUtc: new Date(now).toISOString(),
      expiresAtUtc: new Date(1_001_000).toISOString(),
      playerHealth: status === "lost" ? 0 : 100,
      playerMaxHealth: 100,
      bossHealth: 200,
      bossMaxHealth: 200,
      retryAfterMilliseconds: 0,
    });
    const service = createAutomationService({
      store,
      now: () => now,
      getBoss: (id) => ({ numericId: id, name: "Boss" }),
      fetcher: async (url, init = {}) => {
        const path = new URL(url).pathname;
        calls.push({ path, method: init.method || "GET" });
        if (path === "/api/me")
          return Response.json({ playerId: 101, nickname: "Player" });
        if (path === "/api/me/bag")
          return Response.json({ activityItems: [], consumables: [] });
        if (path === "/api/combat")
          return Response.json({ activeBattle: null });
        if (path === "/api/bosses/7")
          return Response.json({
            id: 7,
            state: { canStartFight: result === "absent" && now > 1_001_000 },
            activeBattle:
              result === "absent" && now > 1_001_000
                ? null
                : rawBattle("active"),
          });
        if (path === "/api/bosses/battles/old-battle")
          return Response.json(
            rawBattle(result === "absent" ? "active" : result),
          );
        throw Error(`Unexpected fake route ${path}`);
      },
    });
    try {
      const entry = await service.identify("Bearer terminal.payload.sig");
      await service.command(entry, {
        id: "terminalopen1",
        command: "open",
        expectedVersion: service.snapshot(entry).version,
        args: { bossId: 7 },
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(service.snapshot(entry).battle.battle.status, "active");
      const before = calls.length;
      now += 2000;
      service.reconcileStored(entry);
      await new Promise((resolve) => setImmediate(resolve));
      const snapshot = service.snapshot(entry);
      if (result === "absent") {
        assert.equal(snapshot.battle.battle, null);
        assert.equal(snapshot.battle.canStart, true);
      } else {
        assert.equal(
          snapshot.battle.battle.status,
          result === "timed_out" ? "expired" : result,
        );
        if (result === "active") assert.equal(snapshot.battle.canStart, false);
      }
      const after = calls.length;
      for (let i = 0; i < 20; i++) service.snapshot(entry);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls.length, after, "no repeated game polling");
      assert.equal(
        calls.slice(before).filter((call) => call.path.includes("/battles/"))
          .length,
        1,
      );
      assert.equal(
        calls.some((call) => call.method === "POST"),
        false,
      );
    } finally {
      service.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
