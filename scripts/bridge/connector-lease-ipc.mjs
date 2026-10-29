import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const PATH = "/internal/bridge/connector-lease";
const WINDOW_MS = 30_000;
const MAX_BODY = 2048;
const headers = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json; charset=utf-8",
};
const error = (code) => Object.assign(new Error(code), { code });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function mac(key, time, nonce, bytes) {
  return createHmac("sha256", key)
    .update(`bridge-connector-lease-v1\n${time}\n${nonce}\n${digest(bytes)}`)
    .digest("hex");
}
function responseMac(key, nonce, status, bytes) {
  return createHmac("sha256", key)
    .update(
      `bridge-connector-response-v1\n${nonce}\n${status}\n${digest(bytes)}`,
    )
    .digest("hex");
}
function keyCheck(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32)
    throw new TypeError("connector_ipc_key_required");
}

/** SQLite receipt store: a replayed authenticated command is never executed. */
export function createConnectorNonceStore(db, routeWitness = null) {
  db.exec(`CREATE TABLE IF NOT EXISTS mobile_bridge_ipc_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mobile_bridge_ipc_clock (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), last_time INTEGER NOT NULL);`);
  return (nonce, now) => {
    if (routeWitness && routeWitness.consumeNonce(nonce, now) !== true)
      return false;
    db.exec("BEGIN IMMEDIATE");
    try {
      const previous = db
        .prepare(
          "SELECT last_time FROM mobile_bridge_ipc_clock WHERE singleton = 1",
        )
        .get();
      if (previous && now < previous.last_time) {
        db.exec("ROLLBACK");
        return false;
      }
      db.prepare(
        "INSERT INTO mobile_bridge_ipc_clock VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET last_time = excluded.last_time",
      ).run(now);
      db.prepare(
        "DELETE FROM mobile_bridge_ipc_nonces WHERE expires_at <= ?",
      ).run(now);
      const size = db
        .prepare("SELECT COUNT(*) AS count FROM mobile_bridge_ipc_nonces")
        .get().count;
      if (size >= 10000) {
        db.exec("ROLLBACK");
        return false;
      }
      const result = db
        .prepare("INSERT OR IGNORE INTO mobile_bridge_ipc_nonces VALUES (?, ?)")
        .run(nonce, now + 2 * WINDOW_MS + 1);
      db.exec("COMMIT");
      return result.changes === 1;
    } catch (caught) {
      db.exec("ROLLBACK");
      throw caught;
    }
  };
}

export function createConnectorLeaseIpcHandler({
  leases,
  directCredentials,
  key,
  consumeNonce,
  now = Date.now,
} = {}) {
  keyCheck(key);
  if (!leases || typeof consumeNonce !== "function")
    throw new TypeError("connector_ipc_dependencies_required");
  const secret = Buffer.from(key);
  return async (request, trustedPeer) => {
    let authenticatedNonce = "";
    const reply = (status, value) => {
      const bytes = Buffer.from(JSON.stringify(value));
      const responseHeaders = { ...headers };
      if (authenticatedNonce)
        responseHeaders["X-Bridge-Response-Signature"] = responseMac(
          secret,
          authenticatedNonce,
          status,
          bytes,
        );
      return new Response(bytes, { status, headers: responseHeaders });
    };
    if (
      trustedPeer !== true ||
      request.method !== "POST" ||
      new URL(request.url).pathname !== PATH ||
      new URL(request.url).search
    )
      return reply(404, { error: "not_found" });
    const stamp = request.headers.get("x-bridge-time") || "";
    const nonce = request.headers.get("x-bridge-nonce") || "";
    const signature = request.headers.get("x-bridge-signature") || "";
    const timestamp = Number(stamp);
    const current = now();
    if (
      !/^[0-9]{13}$/.test(stamp) ||
      !Number.isSafeInteger(timestamp) ||
      !Number.isSafeInteger(current) ||
      Math.abs(current - timestamp) > WINDOW_MS ||
      !/^[a-f0-9]{32}$/.test(nonce) ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      return reply(401, { error: "unauthorized" });
    let bytes;
    try {
      const reader = request.body?.getReader();
      if (!reader) throw new Error();
      const chunks = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(value);
      }
      bytes = Buffer.concat(chunks);
    } catch {
      return reply(400, { error: "invalid_request" });
    }
    const actual = Buffer.from(signature, "hex");
    const expected = Buffer.from(mac(secret, stamp, nonce, bytes), "hex");
    if (!timingSafeEqual(actual, expected))
      return reply(401, { error: "unauthorized" });
    authenticatedNonce = nonce;
    try {
      if (consumeNonce(nonce, current) !== true)
        return reply(409, { error: "request_replayed" });
      const body = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw error("invalid_request");
      if (
        body.action === "acquire" &&
        Object.keys(body).sort().join(",") === "action,kind,owner"
      )
        return reply(200, { leaseId: leases.acquire(body.owner, body.kind) });
      if (
        body.action === "mark" &&
        Object.keys(body).sort().join(",") === "action,leaseId,owner"
      ) {
        leases.markDispatched(body.owner, body.leaseId);
        return reply(200, { ok: true });
      }
      if (
        body.action === "bind" &&
        Object.keys(body).sort().join(",") ===
          "action,credentialDigest,leaseId,owner"
      ) {
        leases.bindCredential(body.owner, body.leaseId, body.credentialDigest);
        return reply(200, { ok: true });
      }
      if (
        body.action === "register" &&
        Object.keys(body).sort().join(",") ===
          "action,credentialDigest,leaseId,owner,playerId"
      ) {
        if (typeof directCredentials?.register !== "function")
          throw error("invalid_request");
        if (
          typeof leases.canRegisterProfile === "function" &&
          !leases.canRegisterProfile(
            body.owner,
            body.leaseId,
            body.credentialDigest,
          )
        )
          throw error("owner_lease_invalid");
        directCredentials.register({
          owner: body.owner,
          playerId: body.playerId,
          credentialDigest: body.credentialDigest,
          leaseId: body.leaseId,
        });
        return reply(200, { ok: true });
      }
      if (
        body.action === "finish_profile_failure" &&
        Object.keys(body).sort().join(",") === "action,leaseId,owner"
      ) {
        if (
          typeof leases.finishKnownProfileFailure !== "function" ||
          !leases.finishKnownProfileFailure(body.owner, body.leaseId)
        )
          throw error("owner_lease_invalid");
        return reply(200, { ok: true });
      }
      if (
        body.action === "finish" &&
        Object.keys(body).sort().join(",") === "action,leaseId,owner"
      ) {
        if (
          !leases.finish(body.owner, body.leaseId, { definitelyFinished: true })
        )
          throw error("owner_lease_invalid");
        return reply(200, { ok: true });
      }
      throw error("invalid_request");
    } catch (caught) {
      if (caught?.code === "bridge_route_required")
        return reply(409, { error: "bridge_route_required" });
      if (
        [
          "invalid_request",
          "invalid_owner_operation",
          "invalid_owner",
          "owner_lease_invalid",
        ].includes(caught?.code) ||
        caught instanceof SyntaxError
      )
        return reply(400, { error: "invalid_request" });
      return reply(503, { error: "bridge_unavailable" });
    }
  };
}

/** Connector-side client. Calls are never retried after an uncertain result. */
export function createConnectorLeaseIpcClient({
  endpoint,
  key,
  fetcher = fetch,
  now = Date.now,
} = {}) {
  keyCheck(key);
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TypeError("invalid_connector_ipc_endpoint");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "wiki" ||
    url.port !== "9094" ||
    url.pathname !== PATH ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    typeof fetcher !== "function"
  )
    throw new TypeError("invalid_connector_ipc_endpoint");
  const secret = Buffer.from(key);
  async function call(body) {
    const bytes = Buffer.from(JSON.stringify(body));
    const time = String(now());
    if (!/^[0-9]{13}$/.test(time)) throw error("bridge_unavailable");
    const nonce = randomBytes(16).toString("hex");
    let response;
    try {
      response = await fetcher(url.href, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bridge-Time": time,
          "X-Bridge-Nonce": nonce,
          "X-Bridge-Signature": mac(secret, time, nonce, bytes),
        },
        body: bytes,
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2048) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(value);
      }
      const responseBytes = Buffer.concat(chunks);
      const signature =
        response.headers.get("x-bridge-response-signature") || "";
      if (!/^[a-f0-9]{64}$/.test(signature)) throw new Error();
      const expected = responseMac(
        secret,
        nonce,
        response.status,
        responseBytes,
      );
      if (
        !timingSafeEqual(
          Buffer.from(signature, "hex"),
          Buffer.from(expected, "hex"),
        )
      )
        throw new Error();
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(responseBytes),
      );
      if (!response.ok)
        throw error(
          value?.error === "bridge_route_required"
            ? "bridge_route_required"
            : "bridge_unavailable",
        );
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error();
      return value;
    } catch (caught) {
      if (caught?.code === "bridge_route_required") throw caught;
      throw error("bridge_unavailable");
    }
  }
  return Object.freeze({
    async acquire(owner, kind) {
      const result = await call({ action: "acquire", owner, kind });
      if (!/^[0-9a-f-]{36}$/.test(result.leaseId || ""))
        throw error("bridge_unavailable");
      return result.leaseId;
    },
    async markDispatched(owner, leaseId) {
      const result = await call({ action: "mark", owner, leaseId });
      if (result.ok !== true) throw error("bridge_unavailable");
    },
    async bindCredential(owner, leaseId, credentialDigest) {
      const result = await call({
        action: "bind",
        owner,
        leaseId,
        credentialDigest,
      });
      if (result.ok !== true) throw error("bridge_unavailable");
    },
    async registerVerified(owner, leaseId, playerId, credentialDigest) {
      const result = await call({
        action: "register",
        owner,
        leaseId,
        playerId,
        credentialDigest,
      });
      if (result.ok !== true) throw error("bridge_unavailable");
    },
    async finish(owner, leaseId, options) {
      if (options?.definitelyFinished !== true)
        throw error("owner_lease_unresolved");
      const result = await call({ action: "finish", owner, leaseId });
      if (result.ok !== true) throw error("bridge_unavailable");
      return true;
    },
    async finishKnownProfileFailure(owner, leaseId) {
      const result = await call({
        action: "finish_profile_failure",
        owner,
        leaseId,
      });
      if (result.ok !== true) throw error("bridge_unavailable");
      return true;
    },
  });
}
