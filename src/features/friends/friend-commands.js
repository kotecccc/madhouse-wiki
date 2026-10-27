// Keep a read and its subsequent mutation on the same authenticated session.
// The bearer value is compared only in memory and is never saved or returned.
export async function sendFriendCommand({
  get,
  post,
  authorize,
  makeId,
  command,
  args,
}) {
  const credential = authorize();
  const current = await get("/api/automation/state", {
    fresh: true,
    revalidate: false,
  });
  if (credential !== authorize()) throw new Error("session_changed");
  return post("/api/automation/commands", {
    id: makeId(),
    expectedVersion: current.version,
    command,
    args: typeof args === "function" ? args(current) : args,
  });
}
