import test from "node:test";
import assert from "node:assert/strict";
import {
  isWikiReadOnlyRestore,
  sharedSessionRestoreReply,
} from "./shared-session-restore.js";

test("connected saved session restores without requiring game progress", () => {
  assert.deepEqual(
    sharedSessionRestoreReply({
      status: "connected",
      accessToken: "saved-game-token",
    }),
    {
      status: "connected",
      accessToken: "saved-game-token",
      gameConnection: "connected",
    },
  );
});

test("saved session restore includes validated progress and active battle", () => {
  assert.deepEqual(
    sharedSessionRestoreReply({
      status: "connected",
      accessToken: "saved-game-token",
      gameConnection: "connected",
      playerLevel: 42,
      currentExp: 17,
      expToNextLevel: 89,
      activeBossBattle: { battleId: "battle-1" },
    }),
    {
      status: "connected",
      accessToken: "saved-game-token",
      gameConnection: "connected",
      playerLevel: 42,
      currentExp: 17,
      expToNextLevel: 89,
      activeBossBattle: { battleId: "battle-1" },
    },
  );
});

test("unverified or revoked saved session cannot produce a connected reply", () => {
  assert.equal(sharedSessionRestoreReply({ status: "revoked" }), null);
  assert.equal(sharedSessionRestoreReply({ status: "unknown" }), null);
  assert.equal(sharedSessionRestoreReply(null), null);
});

test("expired game token restores the Wiki session without exposing a game token", () => {
  const reply = sharedSessionRestoreReply({
    status: "login-required",
    gameConnection: "login-required",
    wikiSession: "signed-wiki-session",
    wikiSessionExpiresAt: 1900000000000,
  });
  assert.deepEqual(reply, {
    status: "wiki-connected",
    wikiSession: "signed-wiki-session",
    wikiSessionExpiresAt: 1900000000000,
    gameConnection: "login-required",
  });
  assert.equal("accessToken" in reply, false);
  assert.equal(
    isWikiReadOnlyRestore({ data: { interactive: false } }, reply),
    true,
  );
  assert.equal(
    isWikiReadOnlyRestore({ data: { interactive: true } }, reply),
    false,
  );
});

test("connected game restore preserves the separate Wiki and game credentials", () => {
  assert.deepEqual(
    sharedSessionRestoreReply({
      status: "connected",
      gameConnection: "connected",
      accessToken: "game-token",
      wikiSession: "wiki-session",
      wikiSessionExpiresAt: 1900000000000,
    }),
    {
      status: "connected",
      accessToken: "game-token",
      gameConnection: "connected",
      wikiSession: "wiki-session",
      wikiSessionExpiresAt: 1900000000000,
    },
  );
});

test("missing Wiki credential does not mask game login requirements", () => {
  assert.equal(
    sharedSessionRestoreReply({
      status: "login-required",
      gameConnection: "login-required",
    }),
    null,
  );
});
