import test from "node:test";
import assert from "node:assert/strict";
import { createPlayerProgressReader } from "./player-progress.mjs";

test("live level is read for the verified own player and unrelated response fields are discarded", async () => {
  const profile = { playerId: 41, energy: { current: 10, max: 100 } };
  const read = createPlayerProgressReader({
    fetcher: async (url, init) => {
      assert.equal(url, "https://cargohustle.online/api/players/41");
      assert.equal(init.headers.Authorization, "Bearer test");
      return Response.json({
        playerId: 41,
        level: 136,
        nickname: "unused",
        userId: 999,
      });
    },
  });
  assert.deepEqual(await read(profile, "Bearer test"), {
    ...profile,
    exp: { level: 136 },
  });
});

test("a different player, missing level or game outage cannot replace own progress", async () => {
  const profile = { playerId: 41, energy: { current: 10, max: 100 } };
  for (const value of [{ playerId: 42, level: 136 }, { playerId: 41 }, null]) {
    const read = createPlayerProgressReader({
      fetcher: async () => {
        if (!value) throw new Error("offline");
        return Response.json(value);
      },
    });
    assert.equal(await read(profile, "Bearer test"), profile);
  }
});

test("an authoritative experience object in the profile needs no supplemental player read", async () => {
  const profile = {
    playerId: 41,
    exp: { level: 136, currentExp: 1, expToNextLevel: 500 },
  };
  const read = createPlayerProgressReader({
    fetcher: () => {
      throw new Error("unexpected read");
    },
  });
  assert.equal(await read(profile, "Bearer test"), profile);
});
