import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";
import { createAutomationService } from "../scripts/automation/service.mjs";

test("account-owned work runner persists before POST, resumes without browser and isolates accounts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "work-farm-service-"));
  const store = createAutomationStateStore({ directory });
  const timers = [],
    calls = [];
  let cycles = 4,
    progress = 1,
    energy = 10;
  const state = () => ({
    workId: 7,
    title: "Work",
    completedCycles: cycles,
    tasks: [
      {
        id: 1,
        title: "Task",
        required: 3,
        progress,
        energyCost: 1,
        canPerform: energy > 0,
      },
    ],
    energy: {
      current: energy,
      max: 10,
      regenIntervalSeconds: 120,
      secondsToNext: 100,
    },
  });
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === "/api/me")
      return Response.json({
        playerId: init.headers.Authorization.includes("other") ? 202 : 101,
        nickname: "Player",
        energy: state().energy,
        wallet: { dollar: 100 },
      });
    if (path === "/api/combat") return Response.json({ activeBattle: null });
    if (path === "/api/me/bag")
      return Response.json({
        boosters: Object.fromEntries(
          ["small", "full"].map((type) => [
            type,
            {
              count: 0,
              restoreEnergy: 10,
              costDollar: 10,
              maxPurchaseQuantity: 10,
            },
          ]),
        ),
      });
    if (path === "/api/works/open") return Response.json(state());
    if (path === "/api/works/tasks/perform") {
      const saved = store.read("101");
      assert.equal(saved.workFarm.run.pending.kind, "performing");
      assert.equal(saved.workFarm.run.actionsDone, progress);
      progress++;
      energy--;
      if (progress === 3) {
        cycles++;
        progress = 0;
      }
      return Response.json(state());
    }
    throw new Error(`Unexpected fake request ${path}`);
  };
  const create = () =>
    createAutomationService({
      store,
      fetcher,
      getBoss: () => null,
      getBusinessCatalogue: () => ({
        businesses: [],
        works: [{ workId: 7 }],
        businessUpgrades: [],
        bosses: [],
      }),
      now: () => 1_000_000,
      random: () => 0,
      schedule: (callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
      },
      cancel: (timer) => {
        timer.canceled = true;
      },
    });
  let service = create();
  const drainOne = async () => {
    const timer = timers.find((timer) => !timer.canceled);
    assert.ok(timer);
    timer.canceled = true;
    timer.callback();
    await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    let entry = await service.identify("Bearer work.payload.sig");
    let id = 0;
    const command = (name, args) =>
      service.command(entry, {
        id: `workcommand${++id}`,
        command: name,
        expectedVersion: service.snapshot(entry).version,
        args,
      });
    await command("work.refresh", { workId: 7 });
    const args = {
      workId: 7,
      targetCycles: 5,
      mode: "wait",
      maxActions: 10,
      durationHours: 1,
      maxBoosters: 0,
      allowPurchase: false,
      maxDollar: 0,
    };
    await command("work.plan", args);
    assert.equal(service.snapshot(entry).workFarm.configs[7].targetCycles, 5);
    assert.equal(service.snapshot(entry).workFarm.view.plan.remainingEnergy, 2);
    await command("work.start", args);
    await assert.rejects(
      command("auto.start", {}),
      (error) => error.status === 409,
    );
    await drainOne();
    assert.equal(progress, 2);
    assert.equal(service.snapshot(entry).workFarm.run.status, "running");
    service.close();
    service = create();
    await service.boot();
    await drainOne();
    entry = await service.identify("Bearer work.payload.sig");
    assert.equal(service.snapshot(entry).workFarm.run.status, "completed");
    assert.equal(service.snapshot(entry).workFarm.run.completedCycles, 5);
    assert.equal(
      calls.filter((path) => path === "/api/works/tasks/perform").length,
      2,
    );
    const other = await service.identify("Bearer other.payload.sig");
    assert.equal(service.snapshot(other).workFarm.run, null);
    assert.equal(service.snapshot(other).workFarm.view, null);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
