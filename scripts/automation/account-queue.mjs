// One in-flight game request per account. Priorities apply between requests;
// never interrupt an uncertain mutation or replay it through this queue.
export function createAccountQueue(
  fetcher,
  { accountKey = (authorization) => authorization, now = Date.now } = {},
) {
  const accounts = new Map();
  function priority(url, init) {
    const path = new URL(url).pathname;
    if (path === "/api/works/tasks/perform") return 30;
    if (/\/attack$/.test(path) || /invitations/.test(path)) return 20;
    return init.method === "POST" ? 10 : 0;
  }
  async function drain(key, lane) {
    if (lane.running) return;
    lane.running = true;
    try {
      while (lane.pending.length) {
        // Age queued reads so a stream of combat actions cannot starve them.
        lane.pending.sort(
          (a, b) =>
            b.priority +
            (now() - b.queuedAt) / 1000 -
            (a.priority + (now() - a.queuedAt) / 1000),
        );
        const job = lane.pending.shift();
        let dispatched = false;
        try {
          job.init.signal?.throwIfAborted();
          const { canDispatch, ...requestInit } = job.init;
          if (canDispatch && !canDispatch())
            throw new DOMException("Queued action cancelled", "AbortError");
          dispatched = true;
          const response = await fetcher(job.url, requestInit);
          // Hold the lane through the body, with the same upper bound used by
          // account actors; an oversized response cannot exhaust the worker.
          const chunks = [];
          let size = 0;
          const reader = response.body?.getReader();
          if (reader)
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > 4 * 1024 * 1024) {
                await reader.cancel();
                throw new Error("game_response_too_large");
              }
              chunks.push(Buffer.from(value));
            }
          const bytes = Buffer.concat(chunks);
          job.resolve(
            new Response(bytes.byteLength ? bytes : null, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            }),
          );
        } catch (error) {
          job.reject(
            dispatched
              ? error
              : Object.assign(
                  error instanceof Error
                    ? error
                    : new Error("Queued action cancelled"),
                  { notDispatched: true },
                ),
          );
        }
      }
    } finally {
      lane.running = false;
      if (!lane.pending.length) accounts.delete(key);
    }
  }
  return (url, init = {}) => {
    const authorization = new Headers(init.headers).get("authorization");
    if (!authorization) return fetcher(url, init);
    const key = accountKey(authorization);
    const lane = accounts.get(key) ?? { pending: [], running: false };
    accounts.set(key, lane);
    if (lane.pending.length >= 128)
      return Promise.reject(
        Object.assign(new Error("account_queue_full"), { notDispatched: true }),
      );
    return new Promise((resolve, reject) => {
      lane.pending.push({
        queuedAt: now(),
        url,
        init,
        resolve,
        reject,
        priority: priority(url, init),
      });
      void drain(key, lane);
    });
  };
}
