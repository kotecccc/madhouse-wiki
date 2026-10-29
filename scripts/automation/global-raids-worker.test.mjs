import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceGlobalRaidDay,
  refreshGlobalRaidRows,
  createGlobalRaidsWorker,
} from "./global-raids-worker.mjs";

const min = 60000;
const start = Date.parse("2026-10-29T20:30:00Z");
const record = (i, extra = {}) => ({
  id: `b${i}`,
  bossId: 7,
  leaderPlayerId: 2,
  leaderName: "Ведущий",
  status: "won",
  startedAt: start + i * min,
  completedAt: start + i * min,
  seenAt: start + i * min,
  ...extra,
});

test("daily rollover retains only continuing raid aggregates and does not double count", () => {
  let state = advanceGlobalRaidDay({}, start);
  for (let i = 0; i < 6; i++) state.observations[`b${i}`] = record(i);
  state = refreshGlobalRaidRows(state, start + 5 * min);
  assert.equal(state.raids[0].count, 6);
  const midnight = Date.parse("2026-10-29T21:00:00Z");
  state = advanceGlobalRaidDay(state, midnight);
  assert.equal(state.raids[0].count, 6);
  assert.deepEqual(state.observations, {});
  state.observations.b6 = record(6, {
    startedAt: midnight + min,
    completedAt: midnight + min,
  });
  state = refreshGlobalRaidRows(state, midnight + min);
  assert.equal(state.raids[0].count, 7);
  state = refreshGlobalRaidRows(state, midnight + min);
  assert.equal(state.raids[0].count, 7);
});

test("all accounts are read, a battle is deduplicated, and uncertain send is checkpointed", async () => {
  let current = start + 10 * min;
  let state = null;
  const accounts = [
    { playerId: "1", credential: "one" },
    { playerId: "2", credential: "two" },
  ];
  const invitations = Array.from({ length: 6 }, (_, i) => ({
    battleId: `b${i}`,
    bossId: 7,
    leaderPlayerId: 2,
  }));
  const reads = [];
  const sends = [];
  const store = {
    readGlobalRaids: () => structuredClone(state),
    writeGlobalRaids: (value) => {
      state = structuredClone(value);
    },
  };
  const worker = createGlobalRaidsWorker({
    store,
    owner: "owner",
    now: () => current,
    chatId: "-123",
    getBoss: () => ({ name: "Босс" }),
    actors: () => accounts,
    canRead: () => true,
    isClosed: () => false,
    telegram: {
      request: async (...args) => {
        sends.push(args);
        throw new Error("lost response");
      },
    },
    readGame: async (credential, path) => {
      reads.push([credential, path]);
      if (path.includes("invitations")) return { items: invitations };
      const id = path.split("/").at(-1);
      const n = Number(id.slice(1));
      return {
        battleId: id,
        bossId: 7,
        leaderPlayerId: 2,
        status: "won",
        createdAtUtc: new Date(start + n * min).toISOString(),
        completedAtUtc: new Date(start + n * min).toISOString(),
        participants: [{ playerId: 2, nickname: "Ведущий" }],
      };
    },
  });
  await worker.tick();
  assert.equal(state.raids[0].count, 6);
  assert.equal(reads.filter(([, p]) => p.includes("invitations")).length, 2);
  assert.equal(state.pendingSend, true);
  current += 5 * min;
  await worker.tick();
  assert.equal(sends.length, 1);
});

test("confirmed sends are edited on later ticks without creating another message", async () => {
  let clock = start;
  let data;
  const calls = [];
  const worker = createGlobalRaidsWorker({
    store: {
      readGlobalRaids: () => structuredClone(data),
      writeGlobalRaids: (value) => {
        data = structuredClone(value);
      },
    },
    owner: "worker",
    now: () => clock,
    chatId: "-123",
    getBoss: () => ({}),
    actors: () => [],
    canRead: () => true,
    isClosed: () => false,
    readGame: async () => {
      throw Error("unexpected read");
    },
    telegram: {
      request: async (method, body) => {
        calls.push({ method, body });
        return method === "sendMessage" ? { message_id: 33 } : true;
      },
    },
  });
  await worker.tick();
  clock += 5 * min;
  await worker.tick();
  assert.deepEqual(
    calls.map((call) => call.method),
    ["sendMessage", "editMessageText"],
  );
  assert.equal(calls[1].body.message_id, 33);
});

test("previous finished raids are discarded on rollover", () => {
  let state = advanceGlobalRaidDay({}, start);
  state.raids = [{ key: "2:7", lastBattleAt: start, count: 6, active: false }];
  state.observations.b0 = record(0);
  state = advanceGlobalRaidDay(state, Date.parse("2026-10-29T21:00:01Z"));
  assert.deepEqual(state.raids, []);
  assert.deepEqual(state.observations, {});
});

test("a battle spanning midnight continues its raid and is counted once", () => {
  const midnight = Date.parse("2026-10-29T21:00:00Z");
  let state = advanceGlobalRaidDay({}, start);
  for (let i = 0; i < 6; i++) state.observations[`b${i}`] = record(i);
  state.observations.b6 = record(6, {
    status: "active",
    startedAt: start + 10 * min,
    completedAt: null,
    seenAt: midnight - min,
  });
  state = refreshGlobalRaidRows(state, midnight - min);
  assert.equal(state.raids[0].active, true);
  state = advanceGlobalRaidDay(state, midnight);
  state.observations.b6 = record(6, {
    startedAt: start + 10 * min,
    completedAt: midnight + min,
    seenAt: midnight + min,
  });
  state = refreshGlobalRaidRows(state, midnight + min);
  assert.equal(state.raids.length, 1);
  assert.equal(state.raids[0].count, 7);
  assert.equal(state.raids[0].active, false);
  state = refreshGlobalRaidRows(state, midnight + min);
  assert.equal(state.raids[0].count, 7);
});
