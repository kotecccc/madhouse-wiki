/** Only the durable queue may accept the currently supported bridge action. */
export async function isAllowedBridgeQueueCommand(request) {
  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    url.pathname !== "/api/automation/commands" ||
    url.search ||
    request.headers.get("content-type")?.split(";")[0] !== "application/json"
  )
    return false;
  try {
    const reader = request.clone().body?.getReader();
    if (!reader) return false;
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) {
        void reader.cancel();
        return false;
      }
      chunks.push(Buffer.from(value));
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return (
      (input?.command === "queue.enqueue" &&
        [
          "friend.response",
          "friend.request",
          "friend.remove",
          "friend.favorite",
          "friend.buddy",
          "energy.booster",
          "inventory",
          "battle.start",
          "battle.attack",
          "battle.heal",
          "battle.buy",
          "auto.start",
          "raid.start",
          "business.start",
          "work.start",
          "work.booster",
          "character.start",
          "stash.craft",
        ].includes(input.args?.type)) ||
      (input?.command === "work.refresh" &&
        Number.isSafeInteger(input.args?.workId) &&
        input.args.workId > 0) ||
      (input?.command === "work.plan" &&
        Number.isSafeInteger(input.args?.workId) &&
        input.args.workId > 0) ||
      [
        "work.stop",
        "auto.pause",
        "auto.resume",
        "auto.stop",
        "raid.pause",
        "raid.resume",
        "raid.stop",
        "business.run.pause",
        "business.run.resume",
        "business.run.stop",
        "business.select",
        "business.save",
        "business.refresh",
        "business.goal",
        "character.refresh",
        "character.stop",
      ].includes(input?.command) ||
      (["buddy.set", "friends.favorite"].includes(input?.command) &&
        Number.isSafeInteger(input.args?.playerId) &&
        input.args.playerId > 0 &&
        typeof input.args.enabled === "boolean") ||
      (input?.command === "buddy.order" &&
        Array.isArray(input.args?.friendIds) &&
        input.args.friendIds.length <= 100 &&
        input.args.friendIds.every(
          (id) => Number.isSafeInteger(id) && id > 0,
        )) ||
      (["queue.cancel", "queue.dismiss"].includes(input?.command) &&
        typeof input.args?.id === "string")
    );
  } catch {
    return false;
  }
}
