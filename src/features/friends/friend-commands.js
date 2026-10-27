// Keep the read, admission and command on the same server-managed session.
export async function sendFriendCommand({
  get,
  post,
  identity,
  command,
  args,
}) {
  const session = identity();
  if (!session) throw new Error("session_changed");
  const current = await get("/api/automation/state", {
    fresh: true,
    revalidate: false,
  });
  if (session !== identity()) throw new Error("session_changed");
  const intent = {
    expectedVersion: current.version,
    command,
    args: typeof args === "function" ? args(current) : args,
  };
  const admission = await post("/api/automation/command-ticket", intent);
  if (session !== identity()) throw new Error("session_changed");
  if (
    typeof admission?.id !== "string" ||
    typeof admission?.ticket !== "string" ||
    !Number.isSafeInteger(admission?.intentVersion)
  )
    throw new Error("invalid_command_admission");
  return post("/api/automation/commands", {
    ...intent,
    id: admission.id,
    admissionTicket: admission.ticket,
    expectedVersion: admission.intentVersion,
  });
}
