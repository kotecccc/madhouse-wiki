import { createServer } from "node:https";
import { once } from "node:events";

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function readBody(request, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > limit) throw new Error("fake_request_too_large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

/** Test-only HTTPS Cargo emulator. It never opens a live game connection. */
export function createFakeCargo({ certificate, privateKey, onRequest }) {
  const requests = [];
  const server = createServer(
    { cert: certificate, key: privateKey, minVersion: "TLSv1.2" },
    (request, response) => {
      void (async () => {
        const record = {
          method: request.method,
          path: request.url,
          servername: request.socket.servername,
          authorization: request.headers.authorization ?? null,
          body: await readBody(request),
        };
        requests.push(record);
        await onRequest(record, response);
      })().catch(() => response.destroy());
    },
  );
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;

  return {
    requests,
    async listen() {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      return server.address().port;
    },
    async close() {
      if (!server.listening) return;
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}
