import test from "node:test";
import assert from "node:assert/strict";
import { profileAvatarUrl } from "../src/features/auth/profile.js";

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
