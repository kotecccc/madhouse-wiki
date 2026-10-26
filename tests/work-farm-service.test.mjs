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
  let failBag = false;
  let smallBoosters = 1;
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
    if (path === "/api/me/bag" && failBag)
      return new Response("bag unavailable", { status: 503 });
    if (path === "/api/me/bag")
      return Response.json({
        boosters: Object.fromEntries(
          ["small", "full"].map((type) => [
            type,
            {
              count: type === "small" ? smallBoosters : 0,
              restoreEnergy: 10,
              costDollar: 10,
              maxPurchaseQuantity: 10,
            },
          ]),
        ),
      });
    if (path === "/api/works/open") return Response.json(state());
    if (path === "/api/me/bag/boosters/use") {
      assert.equal(store.read("101").workFarm.manualPending.type, "small");
      assert.equal(store.read("101").workFarm.manualPending.count, 1);
      smallBoosters--;
      energy = 10;
      return Response.json({ success: true });
    }
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
      accountHealth: () => ({
        status: "unavailable",
        failedFeatures: ["ornaments", "weapons"],
      }),
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
    failBag = true;
    await command("work.refresh", { workId: 7 });
    const partialView = service.snapshot(entry).workFarm.view;
    assert.equal(partialView.workId, 7);
    assert.equal(partialView.tasks[0].progress, progress);
    assert.equal(partialView.energy.current, energy);
    assert.deepEqual(partialView.boosters, []);
    assert.equal(partialView.boostersStatus, "error");
    const mutationCount = calls.filter(
      (path) =>
        path.startsWith("/api/works/tasks/") || path.includes("/boosters/"),
    ).length;
    await command("work.start", {
      workId: 7,
      targetCycles: 5,
      mode: "boosters",
      maxActions: 10,
      durationHours: 1,
      maxBoosters: 10,
      allowPurchase: true,
      maxDollar: 100,
    });
    assert.equal(service.snapshot(entry).workFarm.run.status, "running");
    await command("work.stop", {});
    assert.equal(
      calls.filter(
        (path) =>
          path.startsWith("/api/works/tasks/") || path.includes("/boosters/"),
      ).length,
      mutationCount,
    );
    failBag = false;
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
    // Background reads/other workers can advance the account version after
    // the user selected this job. Named work intent remains valid.
    await service.command(entry, {
      id: "stale-work-intent",
      command: "work.start",
      expectedVersion: 0,
      args,
    });
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
    energy = 0;
    await command("work.booster.use", { workId: 7, type: "small" });
    assert.equal(smallBoosters, 0);
    assert.equal(service.snapshot(entry).workFarm.manualPending, null);
    assert.equal(
      calls.filter((path) => path === "/api/me/bag/boosters/use").length,
      1,
    );
    await assert.rejects(
      command("work.booster.use", { workId: 7, type: "small" }),
    );
    assert.equal(
      calls.filter((path) => path === "/api/me/bag/boosters/use").length,
      1,
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
