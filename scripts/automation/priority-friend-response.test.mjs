import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutomationService } from "./service.mjs";
import { createAutomationStateStore } from "./state-store.mjs";

for (const uncertain of [false, true]) {
  test(`priority friend response ${uncertain ? "keeps uncertain intent without replay" : "completes without a queue job"}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "priority-friend-"));
    const store = createAutomationStateStore({ directory });
    let incoming = true;
    let friend = false;
    let writes = 0;
    const fetcher = async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (
        path === "/api/friends/requests/42/accept" &&
        init.method === "POST"
      ) {
        writes++;
        assert.equal(store.read("1").friendResponse.pending.args.playerId, 42);
        if (uncertain) throw new Error("lost response");
        incoming = false;
        friend = true;
        return Response.json({ success: true });
      }
      if (
        [
          "/api/friends",
          "/api/friends/requests/incoming",
          "/api/friends/requests/outgoing",
        ].includes(path)
      )
        return Response.json({
          items: (
            path === "/api/friends"
              ? friend
              : path.endsWith("/incoming") && incoming
          )
            ? [{ player: { playerId: 42 } }]
            : [],
          nextCursor: null,
        });
      if (path === "/api/combat") return Response.json({ activeBattle: null });
      if (path === "/api/bosses/invitations")
        return Response.json({ items: [] });
      return Response.json({ playerId: 1 });
    };
    const service = createAutomationService({
      store,
      fetcher,
      identifyPlayer: async () => ({ playerId: 1 }),
      getBoss: () => null,
    });
    try {
      await service.boot();
      const entry = await service.identify("Bearer test");
      const input = {
        id: "friend-response-1",
        expectedVersion: service.snapshot(entry).version,
        command: "friends.respond",
        args: { playerId: 42, decision: "accept" },
      };
      if (uncertain) {
        await assert.rejects(service.command(entry, input));
        assert.equal(store.read("1").friendResponse.pending.args.playerId, 42);
        await assert.rejects(
          service.command(entry, {
            ...input,
            id: "friend-response-2",
            expectedVersion: service.snapshot(entry).version,
          }),
        );
      } else {
        const result = await service.command(entry, input);
        assert.equal(result.friendResponse.pending, null);
        assert.equal(
          result.queuedActions.some((job) => job.type === "friend.response"),
          false,
        );
      }
      assert.equal(writes, 1);
    } finally {
      service.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
