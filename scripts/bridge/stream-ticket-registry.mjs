import { createHmac, randomUUID } from "node:crypto";
import { PROTOCOL_VERSION } from "./protocol-v1/control.mjs";
import {
  verifyStreamTicket,
  signStreamTicket,
} from "./protocol-v1/stream-ticket.mjs";

export const STREAM_TICKET_TTL_MS = 15_000;
export const MAX_PENDING_STREAM_TICKETS = 4096;

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function deriveStreamTicketKey(sessionSigningKey) {
  if (
    !(sessionSigningKey instanceof Uint8Array) ||
    sessionSigningKey.byteLength !== 32
  )
    throw new TypeError("bridge_stream_ticket_key_required");
  return new Uint8Array(
    createHmac("sha256", sessionSigningKey)
      .update("madhouse-bridge-stream-ticket-key-v1\0", "utf8")
      .digest(),
  );
}

function pseudonymousOwnerRef(ownerId, key) {
  const normalized = String(ownerId ?? "");
  if (!/^[1-9][0-9]{0,15}$/u.test(normalized))
    throw failure("stream_ticket_invalid");
  const digest = createHmac("sha256", key)
    .update("madhouse-bridge-owner-ref-v1\0", "utf8")
    .update(normalized, "utf8")
    .digest();
  const bytes = digest.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validSession(session) {
  return (
    session &&
    /^[1-9][0-9]{0,15}$/u.test(String(session.ownerId ?? "")) &&
    typeof session.deviceId === "string" &&
    typeof session.connectionId === "string" &&
    Number.isSafeInteger(session.routeEpoch) &&
    session.routeEpoch > 0 &&
    Array.isArray(session.scopes) &&
    session.scopes.includes("data")
  );
}

function sessionMatchesClaims(session, claims, ownerRefFor) {
  return (
    validSession(session) &&
    claims.ownerRef === ownerRefFor(session.ownerId) &&
    claims.deviceId === session.deviceId &&
    claims.connectionId === session.connectionId &&
    claims.routeEpoch === session.routeEpoch
  );
}

export function createStreamTicketRegistry({
  sessionSigningKey,
  now = Date.now,
  uuid = randomUUID,
  maxPending = MAX_PENDING_STREAM_TICKETS,
} = {}) {
  const key = deriveStreamTicketKey(sessionSigningKey);
  if (typeof now !== "function" || typeof uuid !== "function")
    throw new TypeError("bridge_stream_ticket_dependencies_invalid");
  if (
    !Number.isSafeInteger(maxPending) ||
    maxPending < 1 ||
    maxPending > 65_536
  )
    throw new TypeError("bridge_stream_ticket_limit_invalid");

  const tickets = new Map();
  const byConnection = new Map();

  function currentTime() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 1)
      throw failure("stream_ticket_clock_invalid");
    return value;
  }

  function ownerRefFor(ownerId) {
    return pseudonymousOwnerRef(ownerId, key);
  }

  function pruneExpired(timestamp) {
    for (const [ticketId, record] of tickets) {
      if (record.expiresAtMs > timestamp) continue;
      tickets.delete(ticketId);
      if (byConnection.get(record.connectionId) === ticketId)
        byConnection.delete(record.connectionId);
    }
  }

  async function issue({ session, streamId, target = "cargo-main" } = {}) {
    if (!validSession(session) || typeof streamId !== "string")
      throw failure("stream_ticket_invalid");
    const timestamp = currentTime();
    pruneExpired(timestamp);
    if (byConnection.has(session.connectionId)) throw failure("stream_limit");
    if (tickets.size >= maxPending) throw failure("stream_limit");
    const expiresAtMs = timestamp + STREAM_TICKET_TTL_MS;
    if (!Number.isSafeInteger(expiresAtMs))
      throw failure("stream_ticket_clock_invalid");
    const ticketId = uuid();
    const claims = Object.freeze({
      protocolMajor: PROTOCOL_VERSION.major,
      protocolMinor: PROTOCOL_VERSION.minor,
      ticketId,
      purpose: "cargo-stream",
      ownerRef: ownerRefFor(session.ownerId),
      deviceId: session.deviceId,
      connectionId: session.connectionId,
      streamId,
      routeEpoch: session.routeEpoch,
      issuedAtMs: timestamp,
      expiresAtMs,
      target,
    });
    const record = {
      ticketId,
      connectionId: session.connectionId,
      deviceId: session.deviceId,
      routeEpoch: session.routeEpoch,
      streamId,
      ownerRef: claims.ownerRef,
      expiresAtMs,
      status: "signing",
    };
    tickets.set(ticketId, record);
    byConnection.set(session.connectionId, ticketId);
    try {
      const ticket = await signStreamTicket(claims, key);
      if (tickets.get(ticketId) !== record)
        throw failure("stream_ticket_expired");
      record.status = "ready";
      return Object.freeze({ ticket, claims });
    } catch (error) {
      if (tickets.get(ticketId) === record) {
        tickets.delete(ticketId);
        if (byConnection.get(session.connectionId) === ticketId)
          byConnection.delete(session.connectionId);
      }
      throw error;
    }
  }

  async function consume(ticket, session) {
    const timestamp = currentTime();
    pruneExpired(timestamp);
    let claims;
    try {
      claims = await verifyStreamTicket(ticket, key, { nowMs: timestamp });
    } catch {
      throw failure("stream_ticket_invalid");
    }
    const record = tickets.get(claims.ticketId);
    if (!record || record.status !== "ready")
      throw failure("stream_ticket_replayed");
    // Delete before returning so simultaneous upgrade requests cannot both use it.
    tickets.delete(claims.ticketId);
    if (byConnection.get(record.connectionId) === claims.ticketId)
      byConnection.delete(record.connectionId);
    if (
      record.expiresAtMs <= timestamp ||
      claims.expiresAtMs !== record.expiresAtMs ||
      claims.streamId !== record.streamId ||
      claims.deviceId !== record.deviceId ||
      claims.connectionId !== record.connectionId ||
      claims.routeEpoch !== record.routeEpoch ||
      claims.ownerRef !== record.ownerRef ||
      !sessionMatchesClaims(session, claims, ownerRefFor)
    )
      throw failure("stream_ticket_invalid");
    return claims;
  }

  function clearConnection(connectionId) {
    const ticketId = byConnection.get(connectionId);
    if (!ticketId) return false;
    byConnection.delete(connectionId);
    return tickets.delete(ticketId);
  }

  function clear() {
    tickets.clear();
    byConnection.clear();
  }

  return Object.freeze({
    issue,
    consume,
    clearConnection,
    clear,
    ownerRefFor,
    get pendingCount() {
      return tickets.size;
    },
  });
}
