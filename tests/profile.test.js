import test from "node:test";
import assert from "node:assert/strict";
import {
  getProfileStatDisplay,
  normalizeActiveStashBuffs,
  normalizePlayerProfile,
  profileAvatarUrl,
} from "../src/features/auth/profile.js";

test("profile photo uses the API photo or the game CDN player route, never the Telegram ID", () => {
  assert.equal(
    profileAvatarUrl({
      avatarUrl: "https://example.com/photo.webp",
      playerId: 1,
    }),
    "https://example.com/photo.webp",
  );
  assert.equal(
    profileAvatarUrl({ photoUrl: "https://example.com/photo.jpg" }),
    "https://example.com/photo.jpg",
  );
  assert.equal(
    profileAvatarUrl({ playerId: 12, telegramId: 999 }),
    "https://cdn.cargohustle.online/avatarPlayers/12.webp",
  );
  assert.equal(profileAvatarUrl({ telegramId: 999 }), null);
  assert.equal(
    profileAvatarUrl({
      avatarUrl: "javascript:alert(1)",
      playerId: "../other",
    }),
    null,
  );
});

test("active stash buffs normalize plural and legacy singular payloads safely", () => {
  const buffs = normalizeActiveStashBuffs({
    activeStashBuffs: [
      {
        setId: 4,
        title: "  Набор  ",
        expiresAtUtc: "2030-01-01T00:00:00Z",
        previewImageUrl: "javascript:alert(1)",
        madness: 2,
        aggression: -2,
        rage: "bad",
        unrelated: "discard",
      },
      {
        setId: 5,
        name: "Истёкший",
        expiresAtUtc: "2000-01-01T00:00:00Z",
      },
      { setId: 0, name: "invalid", expiresAtUtc: "2030-01-01" },
      { setId: 6, name: "missing expiry" },
    ],
  });
  assert.equal(buffs.length, 2);
  assert.deepEqual(buffs[0], {
    setId: 4,
    name: "Набор",
    expiresAtUtc: "2030-01-01T00:00:00Z",
    expiresAtMs: Date.parse("2030-01-01T00:00:00Z"),
    previewImageUrl: null,
    madness: 2,
    aggression: 0,
    rage: 0,
  });
  assert.equal(buffs[1].setId, 5, "expiry filtering belongs to display time");
  assert.deepEqual(
    normalizeActiveStashBuffs({
      activeStashBuff: {
        setId: 9,
        name: "legacy",
        expiresAtUtc: new Date(2000000000000).toISOString(),
        previewImageUrl: "http://example.com/buff.png",
        rage: 3,
      },
    }),
    [
      {
        setId: 9,
        name: "legacy",
        expiresAtUtc: new Date(2000000000000).toISOString(),
        expiresAtMs: 2000000000000,
        previewImageUrl: "http://example.com/buff.png",
        madness: 0,
        aggression: 0,
        rage: 3,
      },
    ],
  );
});

test("profile keeps original stats and derives temporary amount without double counting", () => {
  const profile = normalizePlayerProfile(
    {
      playerId: 1,
      characterStats: {
        madness: { base: 10, bonus: 5, total: 15 },
        aggression: { base: 20, bonus: 8, total: 28 },
        rage: { base: 30, bonus: 2, total: 32 },
      },
    },
    {
      activeStashBuffs: [
        { setId: 1, name: "a", expiresAtUtc: "2030-01-01", madness: 2 },
        { setId: 2, name: "b", expiresAtUtc: "2030-01-01", madness: 1 },
        { setId: 3, name: "expired", expiresAtUtc: "2000-01-01", madness: 4 },
        { setId: 4, name: "rage", expiresAtUtc: "2030-01-01", rage: 3 },
      ],
    },
  );
  assert.deepEqual(profile.stats, [
    ["Безумие", 15, undefined, "HP"],
    ["Агрессия", 28, undefined, "урон"],
    ["Ярость", 32, undefined, "% шанс крита"],
  ]);
  assert.equal(profile.statBreakdown["Безумие"].base, 10);
  assert.equal(profile.statBreakdown["Безумие"].bonus, 5);
  assert.equal(profile.statBreakdown["Безумие"].total, 15);
  const now = Date.parse("2029-01-01T00:00:00Z");
  assert.deepEqual(getProfileStatDisplay(profile, "Безумие", 15, now), {
    value: 12,
    temporary: 3,
  });
  assert.deepEqual(
    getProfileStatDisplay(profile, "Ярость", 32, now),
    {
      value: 32,
      temporary: 0,
    },
    "temporary exceeds matching bonus, so avoid subtracting it",
  );
});

test("stat display retains persistent bonuses and falls back without reliable breakdown", () => {
  const profile = {
    statBreakdown: {
      Безумие: { statKey: "madness", base: 10, bonus: 7, total: 17 },
      Агрессия: { statKey: "aggression", base: 10, bonus: 2, total: 12 },
    },
    stashBuffs: [{ expiresAtMs: 5000, madness: 3, aggression: 3 }],
  };
  assert.deepEqual(
    getProfileStatDisplay(profile, "Безумие", 17, 1000),
    {
      value: 14,
      temporary: 3,
    },
    "the equipment bonus of 4 stays in the displayed value",
  );
  assert.deepEqual(getProfileStatDisplay(profile, "Агрессия", 12, 1000), {
    value: 12,
    temporary: 0,
  });
  assert.deepEqual(getProfileStatDisplay(profile, "Безумие", 17, 5000), {
    value: 17,
    temporary: 0,
  });
  assert.deepEqual(
    getProfileStatDisplay(
      { stashBuffs: profile.stashBuffs },
      "Безумие",
      17,
      1000,
    ),
    { value: 17, temporary: 0 },
  );
  assert.deepEqual(
    getProfileStatDisplay(
      {
        ...profile,
        statBreakdown: { Безумие: { base: 10, bonus: 7, total: 99 } },
      },
      "Безумие",
      17,
      1000,
    ),
    { value: 17, temporary: 0 },
  );
});
