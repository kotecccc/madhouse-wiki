import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateGlobalRaids,
  projectGlobalRaidBattle,
} from "./global-raids.mjs";

const minute = 60000;

test("leader identity comes from the battle rather than the inviter", () => {
  const invite = {
    battleId: "battle-1",
    bossId: 7,
    leaderPlayerId: 42,
    inviterPlayerId: 99,
    peerNickname: "Inviter",
  };
  const battle = {
    battleId: "battle-1",
    bossId: 7,
    leaderPlayerId: 42,
    status: "active",
    participants: [
      { playerId: 42, nickname: "Leader" },
      { playerId: 99, nickname: "Inviter" },
    ],
  };
  assert.equal(projectGlobalRaidBattle(invite, battle).leaderName, "Leader");
  assert.equal(
    projectGlobalRaidBattle(invite, { ...battle, leaderPlayerId: 99 }),
    null,
  );
  assert.equal(
    projectGlobalRaidBattle(invite, { ...battle, status: "won" }),
    null,
  );
  assert.equal(
    projectGlobalRaidBattle(invite, {
      ...battle,
      status: "won",
      completedAtUtc: "2026-10-29T10:00:00Z",
    }).status,
    "won",
  );
});
const battles = Array.from({ length: 6 }, (_, index) => ({
  id: String(index),
  completedAt: index * minute,
}));

test("detects six distinct completed battles and counts the entire series", () => {
  assert.deepEqual(
    calculateGlobalRaids([...battles, battles[0]], false, 5 * minute),
    [
      {
        startedAt: 0,
        detectedAt: 5 * minute,
        lastBattleAt: 5 * minute,
        count: 6,
        status: "waiting",
      },
    ],
  );
  assert.deepEqual(
    calculateGlobalRaids(battles.slice(0, 5), false, 5 * minute),
    [],
  );
});

test("status boundaries and active battles", () => {
  const status = (elapsed, active = false) =>
    calculateGlobalRaids(battles, active, (5 + elapsed) * minute)[0].status;
  assert.equal(status(5), "waiting");
  assert.equal(status(6), "paused");
  assert.equal(status(30), "paused");
  assert.equal(status(31), "finished");
  assert.equal(status(90, true), "active");
});

test("a break over 30 minutes separates a new raid", () => {
  const later = battles.map(({ id, completedAt }) => ({
    id: `next${id}`,
    completedAt: completedAt + 40 * minute,
  }));
  const raids = calculateGlobalRaids(
    [...battles, ...later],
    false,
    45 * minute,
  );
  assert.equal(raids.length, 2);
  assert.equal(raids[0].status, "finished");
  assert.equal(raids[1].count, 6);
});
