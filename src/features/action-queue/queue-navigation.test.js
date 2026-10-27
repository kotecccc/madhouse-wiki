import { test } from "node:test";
import assert from "node:assert/strict";
import { queueNavigation } from "./queue-navigation.js";

test("floor automation opens its destination department and category", () => {
  assert.deepEqual(
    queueNavigation(
      {
        destination: "floor",
        floorTarget: {
          kind: "business",
          destination: "D",
          entityId: "business-shop",
        },
      },
      {
        floors: [
          { id: "floor-c", code: "C" },
          { id: "floor-d", code: "D" },
        ],
        departments: [{ id: "department-c2", code: "C2", floorId: "floor-c" }],
        businesses: [{ id: "business-shop", departmentId: "department-c2" }],
      },
    ),
    {
      screen: "overview",
      floorCode: "C",
      focus: {
        kind: "floor",
        category: "businesses",
        departmentId: "department-c2",
        entityId: "business-shop",
      },
    },
  );
});

test("floor unlock targets open the requested floor without a department", () => {
  assert.deepEqual(
    queueNavigation(
      {
        destination: "floor.start",
        floorTarget: { kind: "floor", destination: "D" },
      },
      { floors: [{ id: "floor-d", code: "D" }], departments: [] },
    ),
    {
      screen: "overview",
      floorCode: "D",
      focus: {
        kind: "floor",
        category: "work",
        departmentId: null,
        entityId: null,
      },
    },
  );
});

test("work targets resolve their owning department by canonical work ID", () => {
  assert.deepEqual(
    queueNavigation(
      {
        destination: "floor",
        floorTarget: {
          kind: "work",
          destination: "C2",
          entityId: "work-c1",
        },
      },
      {
        floors: [{ id: "floor-c", code: "C" }],
        departments: [
          {
            id: "department-c1",
            code: "C1",
            floorId: "floor-c",
            work: { id: "work-c1" },
          },
        ],
      },
    ),
    {
      screen: "overview",
      floorCode: "C",
      focus: {
        kind: "floor",
        category: "work",
        departmentId: "department-c1",
        entityId: "work-c1",
      },
    },
  );
});

test("boss targets open the owning department on the boss category", () => {
  assert.deepEqual(
    queueNavigation(
      {
        destination: "floor",
        floorTarget: {
          kind: "boss",
          destination: "C2",
          entityId: "boss-c1",
        },
      },
      {
        floors: [{ id: "floor-c", code: "C" }],
        departments: [{ id: "department-c1", code: "C1", floorId: "floor-c" }],
        bosses: [{ id: "boss-c1", departmentId: "department-c1" }],
      },
    ),
    {
      screen: "overview",
      floorCode: "C",
      focus: {
        kind: "floor",
        category: "bosses",
        departmentId: "department-c1",
        entityId: "boss-c1",
      },
    },
  );
});

test("subscription and friend request cards open the matching raid context", () => {
  const target = {
    leaderPlayerId: 42,
    leaderUsername: "leader",
    bossId: 7,
  };
  assert.deepEqual(
    queueNavigation({ destination: "subscription", raidTarget: target }),
    { screen: "raids", focus: { kind: "raid", target } },
  );
  assert.deepEqual(
    queueNavigation({ destination: "friend.request", raidTarget: target }),
    { screen: "raids", focus: { kind: "raid", target } },
  );
});

test("friend and Buddy actions open their matching controls", () => {
  assert.deepEqual(
    queueNavigation({
      destination: "friend.buddy",
      friendTarget: { playerId: 42 },
    }),
    { screen: "friends", focus: { kind: "friend", playerId: 42 } },
  );
  assert.deepEqual(queueNavigation({ destination: "buddy" }), {
    screen: "friends",
    focus: { kind: "buddy" },
  });
});
