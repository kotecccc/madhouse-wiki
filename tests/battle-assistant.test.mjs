import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseBattleAction,
  createBattleAssistant,
  defaultHealingSettings,
  invitationDecision,
  validateHealingSettings,
} from "../scripts/automation/battle-assistant.mjs";

const baseState = (patch = {}) => ({
  boss: { id: 7 },
  damageLimit: { bossId: 7, value: 50, source: "api.damageMax" },
  battle: {
    id: "battle-1",
    status: "active",
    playerHealth: 50,
    playerMaxHealth: 100,
    readyAt: 0,
    bossHealth: 1000,
    quotaFresh: true,
    dropDamageRequired: 100,
    totalDamage: 0,
    participantCount: 1,
    maxParticipants: 10,
  },
  medicines: [
    {
      type: "heal_10",
      quantity: 1,
      maxPurchaseQuantity: 10,
      prices: [{ currency: "gold", amount: 5 }],
    },
    {
      type: "heal_full",
      quantity: 1,
      maxPurchaseQuantity: 10,
      prices: [{ currency: "pills", amount: 3 }],
    },
  ],
  ...patch,
});

const enabledSettings = (patch = {}) =>
  validateHealingSettings({
    ...defaultHealingSettings(),
    enabled: true,
    items: {
      heal_10: { enabled: true, limit: 3, currency: "gold" },
      heal_full: { enabled: true, limit: 3, currency: "pills" },
    },
    budgets: { gold: 100, dollar: 0, pills: 100 },
    ...patch,
  });

function fakeController(initial = baseState(), handlers = {}) {
  const calls = [];
  const refreshOptions = [];
  let snapshot = initial;
  const controller = {
    calls,
    refreshOptions,
    getSnapshot: () => snapshot,
    setSnapshot: (next) => {
      snapshot = next;
    },
    async useMedicine(type, options) {
      calls.push(["use", type]);
      const allowed = options.allowed({ operationId: `use-${calls.length}` });
      if (!allowed) return;
      return handlers.use?.(type, options) ?? { confirmed: true };
    },
    async buyMedicine({ quote, allowed }) {
      calls.push(["buy", quote]);
      const permitted = allowed(quote, { operationId: `buy-${calls.length}` });
      if (!permitted) return;
      return handlers.buy?.(quote) ?? { confirmed: true };
    },
    async loadMedicines() {
      calls.push(["stock"]);
    },
    async refresh(options) {
      calls.push(["refresh"]);
      refreshOptions.push(options);
      await handlers.refresh?.(controller, options);
    },
    async refreshDamageLimit() {
      calls.push(["limit"]);
    },
    async inviteAll({ beforeSend }) {
      calls.push(["invite"]);
      beforeSend({ operationId: `invite-${calls.length}` });
      return handlers.invite?.() ?? { known: true, invitedCount: 1 };
    },
    async attack() {
      calls.push(["attack"]);
    },
  };
  return controller;
}

test("healing settings validate known fields, integer limits and currency budgets", () => {
  const valid = enabledSettings();
  assert.equal(valid.items.heal_10.currency, "gold");
  assert.throws(
    () =>
      validateHealingSettings({
        ...valid,
        items: {
          ...valid.items,
          heal_10: { ...valid.items.heal_10, limit: -1 },
        },
      }),
    /invalid_healing_settings/,
  );
  assert.throws(
    () =>
      validateHealingSettings({
        ...valid,
        budgets: { ...valid.budgets, pills: 1.5 },
      }),
    /invalid_healing_budget/,
  );
});

test("action choice requires a bound, treats equality as lethal, and rejects ineffective healing", () => {
  const state = baseState();
  const ledger = {
    settings: enabledSettings(),
    used: { heal_10: 0, heal_full: 0 },
    spent: { gold: 0, dollar: 0, pills: 0 },
  };
  assert.equal(chooseBattleAction(state, ledger, null).kind, "stop");
  assert.equal(chooseBattleAction(state, ledger, 50).kind, "heal");
  assert.equal(
    chooseBattleAction(
      {
        ...state,
        battle: { ...state.battle, playerHealth: 100, playerMaxHealth: 100 },
      },
      { settings: enabledSettings() },
      100,
    ).kind,
    "stop",
  );
  const full = chooseBattleAction(
    {
      ...state,
      medicines: state.medicines.map((item) => ({
        ...item,
        quantity: item.type === "heal_full" ? 1 : 0,
      })),
    },
    {
      settings: enabledSettings(),
      used: { heal_10: 3, heal_full: 0 },
      spent: { gold: 0, dollar: 0, pills: 0 },
    },
    90,
  );
  assert.deepEqual(full, { kind: "heal", type: "heal_full" });
});

test("small healing is chosen when it safely clears the bound; full healing is chosen otherwise", () => {
  const state = baseState();
  const ledger = {
    settings: enabledSettings(),
    used: { heal_10: 0, heal_full: 0 },
    spent: { gold: 0, dollar: 0, pills: 0 },
  };
  assert.deepEqual(chooseBattleAction(state, ledger, 59), {
    kind: "heal",
    type: "heal_10",
  });
  assert.deepEqual(chooseBattleAction(state, ledger, 60), {
    kind: "heal",
    type: "heal_full",
  });
});

test("item-limit purchase mode needs no money budget and still respects battle limits", () => {
  const state = baseState({
    medicines: baseState().medicines.map((item) => ({ ...item, quantity: 0 })),
  });
  const settings = enabledSettings({
    autoBuy: true,
    budgetMode: "item_limits",
    budgets: { gold: 0, dollar: 0, pills: 0 },
  });
  const healing = {
    settings,
    used: { heal_10: 0, heal_full: 0 },
    spent: { gold: 0, dollar: 0, pills: 0 },
  };
  assert.equal(settings.budgetMode, "item_limits");
  assert.equal(chooseBattleAction(state, healing, 90).kind, "buy");
  healing.used = { heal_10: 3, heal_full: 3 };
  assert.equal(chooseBattleAction(state, healing, 90).kind, "stop");
});

test("zero item limit and zero purchase budget disable those paths; quote currency is honored", () => {
  const state = baseState({
    medicines: baseState().medicines.map((item) => ({ ...item, quantity: 0 })),
  });
  const noHealLimit = enabledSettings({
    items: {
      heal_10: { enabled: true, limit: 0, currency: "gold" },
      heal_full: { enabled: false, limit: 0, currency: "pills" },
    },
    autoBuy: true,
    budgets: { gold: 0, dollar: 0, pills: 0 },
  });
  assert.equal(
    chooseBattleAction(
      state,
      {
        settings: noHealLimit,
        used: { heal_10: 0, heal_full: 0 },
        spent: { gold: 0, dollar: 0, pills: 0 },
      },
      50,
    ).kind,
    "stop",
  );
  const onlyFull = enabledSettings({
    autoBuy: true,
    items: {
      heal_10: { enabled: false, limit: 2, currency: "gold" },
      heal_full: { enabled: true, limit: 2, currency: "pills" },
    },
    budgets: { gold: 0, dollar: 0, pills: 10 },
  });
  const result = chooseBattleAction(
    state,
    {
      settings: onlyFull,
      used: { heal_10: 0, heal_full: 0 },
      spent: { gold: 0, dollar: 0, pills: 0 },
    },
    90,
  );
  assert.equal(result.kind, "buy");
  assert.equal(result.quote.currency, "pills");
  assert.equal(result.quote.total, 3);
});

test("reservations are persisted before callbacks resolve and unknown actions are not replayed after restart", async () => {
  let assistant;
  const controller = fakeController(baseState(), {
    use: async () => {
      assert.equal(assistant.exportState().pending.kind, "heal");
      return { confirmed: false };
    },
  });
  assistant = createBattleAssistant({
    controller,
    now: () => 1000,
  });
  assistant.configure(enabledSettings());
  assistant.begin("goal-1");
  const result = await assistant.use("heal_10", true);
  assert.equal(result.kind, "wait");
  assert.equal(assistant.exportState().pending.kind, "heal");
  const restored = createBattleAssistant({
    controller,
    saved: assistant.exportState(),
    now: () => 1000,
  });
  const callsBefore = controller.calls.length;
  assert.equal((await restored.step()).kind, "wait");
  assert.deepEqual(controller.calls.slice(callsBefore), [["refresh"]]);
});

test("lost start response is reconciled from a discovered active battle for the intended boss", async () => {
  const controller = fakeController(
    baseState({ battle: null, needsRefresh: true, canStart: false }),
    {
      refresh: (current, options) => {
        assert.deepEqual(options, { discover: true });
        current.setSnapshot(
          baseState({ battle: { ...baseState().battle, id: "battle-new" } }),
        );
      },
    },
  );
  const assistant = createBattleAssistant({
    controller,
    saved: {
      pending: {
        kind: "start",
        operationId: "start-op",
        bossId: 7,
        beforeBattleId: null,
        battleId: null,
      },
      battles: {},
    },
  });

  assert.equal(await assistant.recover(), true);
  assert.equal(assistant.projection().uncertain, false);
  assert.deepEqual(controller.refreshOptions, [{ discover: true }]);
  assert.deepEqual(controller.calls, [["refresh"], ["stock"], ["limit"]]);
});

test("unknown start state stays pending after discovery and never retries the start", async () => {
  const controller = fakeController(
    baseState({ battle: null, needsRefresh: true, canStart: false }),
  );
  const assistant = createBattleAssistant({
    controller,
    saved: {
      pending: {
        kind: "start",
        operationId: "start-op",
        bossId: 7,
        beforeBattleId: null,
        battleId: null,
      },
      battles: {},
    },
  });

  assert.equal(await assistant.recover(), false);
  assert.equal(assistant.projection().uncertain, true);
  assert.deepEqual(controller.refreshOptions, [{ discover: true }]);
  assert.deepEqual(controller.calls, [["refresh"]]);
});

test("a bridge route keeps an unreviewed start pending after discovery", async () => {
  const controller = fakeController(
    baseState({ battle: null, needsRefresh: true, canStart: false }),
    {
      refresh: (current) => {
        current.setSnapshot(
          baseState({ battle: { ...baseState().battle, id: "battle-new" } }),
        );
      },
    },
  );
  const assistant = createBattleAssistant({
    controller,
    canReconcileStart: () => false,
    saved: {
      pending: {
        kind: "start",
        operationId: "start-op",
        bossId: 7,
        beforeBattleId: null,
        battleId: null,
      },
      battles: {},
    },
  });
  assert.equal(await assistant.recover(), false);
  assert.equal(assistant.projection().uncertain, true);
  assert.deepEqual(controller.calls, [["refresh"]]);
});

test("battle use counts reset by battle identity; run budgets persist until a new goal", async () => {
  const controller = fakeController();
  controller.setSnapshot(
    baseState({ battle: { ...baseState().battle, playerHealth: 45 } }),
  );
  const assistant = createBattleAssistant({
    controller,
  });
  assistant.configure(enabledSettings());
  assistant.begin("goal-1");
  await assistant.use("heal_10");
  assert.equal(assistant.projection().used.heal_10, 1);
  controller.setSnapshot(
    baseState({ battle: { ...baseState().battle, id: "battle-2" } }),
  );
  assert.equal(assistant.projection().used.heal_10, 0);
  const quote = {
    type: "heal_10",
    currency: "gold",
    quantity: 1,
    unitPrice: 5,
    total: 5,
  };
  await assistant.buy(quote);
  assert.equal(assistant.projection().spent.gold, 5);
  assistant.begin("goal-1");
  assert.equal(assistant.projection().spent.gold, 5);
  assistant.begin("goal-2");
  assert.equal(assistant.projection().spent.gold, 0);
});

test("healing settings are account-wide and legacy boss profiles migrate", async () => {
  const controller = fakeController();
  const config = enabledSettings();
  const legacy = createBattleAssistant({
    controller,
    saved: {
      profiles: { 7: config, 8: { ...config, enabled: false } },
      battles: {
        "battle-1": { used: { heal_10: 1, heal_full: 0 } },
        "battle-2": { used: { heal_10: 0, heal_full: 0 } },
      },
      spent: { gold: 4, dollar: 0, pills: 0 },
    },
  });
  assert.equal(legacy.projection().settings.enabled, true);
  assert.equal(legacy.exportState().profiles, undefined);
  assert.equal(legacy.exportState().healingSettings.enabled, true);

  controller.setSnapshot(baseState({ boss: { id: 8 } }));
  assert.equal(legacy.projection().settings.enabled, true);
  assert.equal(legacy.projection().used.heal_10, 1);
  controller.setSnapshot(
    baseState({
      boss: { id: 8 },
      battle: { ...baseState().battle, id: "battle-2" },
    }),
  );
  assert.equal(legacy.projection().settings.enabled, true);
  assert.equal(legacy.projection().used.heal_10, 0);
  assert.equal(legacy.projection().spent.gold, 4);

  const updated = { ...config, enabled: false };
  legacy.configure(updated);
  const restored = createBattleAssistant({
    controller,
    saved: legacy.exportState(),
  });
  assert.equal(restored.projection().settings.enabled, false);
  assert.equal(restored.projection().settings.items.heal_10.limit, 3);
});

test("first invitation is immediate; repeats require fresh quota and persist their cooldown", async () => {
  let time = 100_000;
  const controller = fakeController(
    baseState({
      damageLimit: { bossId: 7, value: 40 },
      battle: {
        ...baseState().battle,
        readyAt: time + 10_000,
        totalDamage: 100,
      },
    }),
  );
  const assistant = createBattleAssistant({
    controller,
    now: () => time,
    random: () => 0,
  });
  assistant.configure(enabledSettings());
  assistant.begin("goal-1");
  assert.equal((await assistant.step()).kind, "invite");
  controller.setSnapshot(
    baseState({
      damageLimit: { bossId: 7, value: 40 },
      battle: {
        ...baseState().battle,
        readyAt: time + 10_000,
        quotaFresh: false,
        totalDamage: 100,
      },
    }),
  );
  assert.equal((await assistant.step()).kind, "wait");
  assert.ok(
    assistant
      .projection()
      .invitationNotice.includes("норма урона не подтверждена"),
  );
  controller.setSnapshot(
    baseState({
      damageLimit: { bossId: 7, value: 40 },
      battle: {
        ...baseState().battle,
        readyAt: time + 10_000,
        totalDamage: 100,
      },
    }),
  );
  time += 40_000;
  controller.setSnapshot(
    baseState({
      damageLimit: { bossId: 7, value: 40 },
      battle: {
        ...baseState().battle,
        readyAt: time + 10_000,
        totalDamage: 100,
      },
    }),
  );
  const result = await assistant.step();
  assert.equal(result.kind, "invite");
  assert.ok(controller.calls.some(([kind]) => kind === "refresh"));
  assert.ok(controller.calls.some(([kind]) => kind === "invite"));
  const state = assistant.exportState();
  assert.ok(state.battles["battle-1"].inviteAt > time);
  const restarted = createBattleAssistant({
    controller,
    saved: state,
    now: () => time,
    random: () => 0,
  });
  assert.equal(
    restarted.nextActionAt(time + 10_000),
    Math.min(time + 10_000, state.battles["battle-1"].inviteAt),
  );
});

test("manual medicine operation reserves before send and charges confirmed purchase budget", async () => {
  let assistant;
  const controller = fakeController(baseState(), {
    buy: async () => {
      assert.equal(assistant.exportState().pending.kind, "buy");
      return { confirmed: true };
    },
  });
  assistant = createBattleAssistant({ controller });
  assistant.configure(enabledSettings());
  assistant.begin("goal-1");
  await assistant.buy(
    { type: "heal_10", currency: "gold", quantity: 1, unitPrice: 5, total: 5 },
    false,
  );
  assert.equal(assistant.projection().spent.gold, 5);
  assert.equal(assistant.exportState().pending, null);
});

test("invitation decision waits until quota is fresh and met", () => {
  const battle = baseState().battle;
  assert.match(
    invitationDecision({ ...battle, quotaFresh: false }),
    /норма урона не подтверждена/,
  );
  assert.match(
    invitationDecision({ ...battle, totalDamage: 99 }),
    /набираем норму/,
  );
  assert.equal(invitationDecision({ ...battle, totalDamage: 100 }), null);
});

test("disabling automatic healing does not reset configured manual limits or spending budget", async () => {
  const controller = fakeController();
  const assistant = createBattleAssistant({
    controller,
  });
  const config = enabledSettings();
  config.items.heal_10.limit = 1;
  config.budgets.gold = 5;
  assistant.configure(config);
  await assistant.use("heal_10");
  await assistant.buy({
    type: "heal_10",
    currency: "gold",
    quantity: 1,
    unitPrice: 5,
    total: 5,
  });
  assistant.configure({ ...config, enabled: false });
  const before = controller.calls.length;
  assert.equal((await assistant.use("heal_10")).kind, "stop");
  assert.equal(
    (
      await assistant.buy({
        type: "heal_10",
        currency: "gold",
        quantity: 1,
        unitPrice: 5,
        total: 5,
      })
    ).kind,
    "wait",
  );
  assert.equal(
    controller.calls.slice(before).filter(([kind]) => kind === "use").length,
    0,
  );
  assert.equal(assistant.projection().spent.gold, 5);
});

test("available effective full medicine is used before buying a missing small medicine", () => {
  const state = baseState();
  state.medicines[0].quantity = 0;
  const action = chooseBattleAction(
    state,
    {
      settings: enabledSettings({ autoBuy: true }),
      used: { heal_10: 0, heal_full: 0 },
      spent: { gold: 0, dollar: 0, pills: 0 },
    },
    55,
  );
  assert.deepEqual(action, { kind: "heal", type: "heal_full" });
});

test("read recovery can clear an outage while mutation availability remains gated", async () => {
  let online = false;
  const controller = fakeController(
    baseState({ battle: { ...baseState().battle, playerHealth: 80 } }),
  );
  controller.refreshDamageLimit = async () => {
    controller.calls.push(["limit"]);
  };
  const assistant = createBattleAssistant({
    controller,
    available: () => online,
    readAvailable: () => true,
    refreshAvailability: async () => {
      online = true;
    },
  });
  assistant.begin("outage-run");
  assert.equal(await assistant.recover(), true);
  assert.equal(online, true);
  assert.equal(
    controller.calls.some(([kind]) => kind === "attack"),
    false,
  );
  assert.ok(controller.calls.some(([kind]) => kind === "stock"));
});

test("uncertain strikes refresh the battle and clear only after confirmed personal damage", async () => {
  const controller = fakeController(baseState());
  controller.refreshDamageLimit = async () => {};
  const assistant = createBattleAssistant({
    controller,
    saved: {
      pending: { kind: "attack", battleId: "battle-1", beforeDamage: 0 },
      battles: { "battle-1": { used: {}, samples: [] } },
    },
  });
  assert.equal(await assistant.recover(), false);
  assert.equal(assistant.projection().uncertain, true);
  controller.setSnapshot({
    ...controller.getSnapshot(),
    battle: { ...controller.getSnapshot().battle, totalDamage: 50 },
  });
  assert.equal(await assistant.recover(), true);
  assert.equal(assistant.projection().uncertain, false);
  assert.equal(
    controller.calls.filter(([kind]) => kind === "refresh").length,
    2,
  );
  assert.equal(
    controller.calls.some(([kind]) => kind === "attack"),
    false,
  );
});

test("a different battle ID does not resolve an old strike without evidence", async () => {
  const controller = fakeController(baseState());
  controller.refreshDamageLimit = async () => {};
  const assistant = createBattleAssistant({
    controller,
    saved: {
      pending: { kind: "attack", battleId: "previous-battle" },
      battles: {},
    },
  });
  assert.equal(await assistant.recover(), false);
  assert.equal(assistant.projection().uncertain, true);
  assert.equal(
    controller.calls.some(([kind]) => kind === "attack"),
    false,
  );
});

test("stop during outage recovery cannot submit a late attack", async () => {
  let online = false,
    release;
  const controller = fakeController(
    baseState({ battle: { ...baseState().battle, playerHealth: 80 } }),
  );
  controller.refreshDamageLimit = async () => {};
  const assistant = createBattleAssistant({
    controller,
    available: () => online,
    readAvailable: () => true,
    refreshAvailability: () =>
      new Promise((resolve) => {
        release = () => {
          online = true;
          resolve();
        };
      }),
  });
  assistant.begin("outage-stop");
  const running = assistant.step();
  await new Promise(setImmediate);
  assistant.cancel();
  release();
  await running;
  assert.equal(
    controller.calls.some(([kind]) => kind === "attack"),
    false,
  );
});

test("joining a battle invites before the first ready strike even before personal quota", async () => {
  const controller = fakeController(
    baseState({ damageLimit: { bossId: 7, value: 40 } }),
  );
  const assistant = createBattleAssistant({
    controller,
    now: () => 100000,
    random: () => 0,
  });
  assistant.begin("new-raid");
  const result = await assistant.step();
  assert.equal(result.kind, "invite");
  assert.ok(!controller.calls.some(([kind]) => kind === "attack"));
  assert.equal(assistant.projection().invitation.invitedCount, 1);
  assert.equal(assistant.projection().invitation.nextAt, 135000);
  assert.equal((await assistant.step()).kind, "attack");
});

test("only a matching operation proven unsent can release a reservation", () => {
  const controller = fakeController();
  const assistant = createBattleAssistant({
    controller,
    saved: {
      pending: {
        kind: "attack",
        operationId: "queued-operation",
        battleId: "battle-1",
      },
      battles: {},
    },
  });
  assert.equal(assistant.releaseUnsent("different-operation"), false);
  assert.equal(assistant.exportState().pending.operationId, "queued-operation");
  assert.equal(assistant.releaseUnsent("queued-operation"), true);
  assert.equal(assistant.exportState().pending, null);
});
