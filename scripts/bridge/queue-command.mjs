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
        input.args?.type === "friend.response") ||
      (["queue.cancel", "queue.dismiss"].includes(input?.command) &&
        typeof input.args?.id === "string")
    );
  } catch {
    return false;
  }
}
