import test from "node:test";
import assert from "node:assert/strict";
import { defaultRaidSection } from "./raid-default-section.js";

test("default raid section waits for personal data and chooses the first nonempty list", () => {
  const data = {
    authenticated: true,
    raidsLoaded: true,
    invitationsLoaded: true,
    raidCount: 0,
    invitationCount: 0,
  };
  assert.equal(defaultRaidSection({ ...data, raidsLoaded: false }), null);
  assert.equal(defaultRaidSection({ ...data, invitationsLoaded: false }), null);
  assert.equal(
    defaultRaidSection({ ...data, raidCount: 2, invitationCount: 3 }),
    "raids",
  );
  assert.equal(
    defaultRaidSection({ ...data, invitationCount: 3 }),
    "invitations",
  );
  assert.equal(defaultRaidSection(data), "announcements");
  assert.equal(defaultRaidSection({ authenticated: false }), "announcements");
});
