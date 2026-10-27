import { Agent, interceptors, request } from "undici";
import { createGameTlsDuplexConnector } from "./tls-duplex-connector.mjs";

const CARGO_ORIGIN = "https://cargohustle.online";
export const MAX_GAME_RESPONSE_BODY_BYTES = 4 * 1024 * 1024;
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const BODYLESS_STATUSES = new Set([204, 205, 304]);

function bridgeError(code) {
  return Object.assign(new Error(code), { code, status: 503 });
}

function responseHeaders(source) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source || {})) {
    if (value == null || HOP_BY_HOP_RESPONSE_HEADERS.has(name.toLowerCase()))
      continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, String(item));
    } else headers.set(name, String(value));
  }
  return headers;
}

function disposeAgent(agent) {
  void agent.destroy().catch(() => {});
}

function boundedResponseBody(nodeBody, agent) {
  const iterator = nodeBody[Symbol.asyncIterator]();
  let receivedBytes = 0;
  let settled = false;
  let disposed = false;
  let stopFlight = null;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    disposeAgent(agent);
  };
  const stop = () => {
    if (stopFlight) return stopFlight;
    if (!nodeBody.destroyed) nodeBody.destroy();
    stopFlight = (async () => {
      try {
        await iterator.return?.();
      } catch {
        // The iterator may already have ended or failed.
      }
      dispose();
    })();
    return stopFlight;
  };

  return new ReadableStream({
    async pull(controller) {
      if (settled) return;
      try {
        const { done, value } = await iterator.next();
        if (settled) return;
        if (done) {
          settled = true;
          controller.close();
          dispose();
          return;
        }
        receivedBytes += value.byteLength;
        if (receivedBytes > MAX_GAME_RESPONSE_BODY_BYTES) {
          settled = true;
          controller.error(bridgeError("bridge_response_too_large"));
          await stop();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        if (!settled) {
          settled = true;
          controller.error(error);
        }
        await stop();
      }
    },
    async cancel() {
      settled = true;
      await stop();
    },
  });
}

/**
 * Creates the read/write transport used by GameApiClient for bridge-required
 * routes. TLS and HTTP remain on Wiki; the desktop only supplies a TCP byte
 * stream to the fixed Cargo endpoint.
 */
export function createGameApiTunnelTransport({
  openStream,
  bindMutationConnection = null,
  requestFn = request,
  AgentClass = Agent,
  tlsConnect,
} = {}) {
  if (typeof openStream !== "function")
    throw new TypeError("bridge_stream_opener_required");
  if (
    bindMutationConnection !== null &&
    typeof bindMutationConnection !== "function"
  )
    throw new TypeError("bridge_mutation_connection_binder_invalid");
  if (typeof requestFn !== "function" || typeof AgentClass !== "function")
    throw new TypeError("bridge_transport_dependencies_invalid");

  return async function bridgeTransport({
    route,
    upstreamPath,
    search = "",
    method,
    headers,
    body,
    signal,
    admission,
  }) {
    const mutationAdmission =
      admission?.action === "boss.attack" ? admission : null;
    if (
      route?.policy !== "bridge_required" ||
      typeof route.activeDeviceId !== "string" ||
      !Number.isSafeInteger(route.routeEpoch) ||
      route.routeEpoch < 1 ||
      !/^\/api\/[A-Za-z0-9_./{}$-]*$/u.test(upstreamPath || "") ||
      upstreamPath.includes("..") ||
      /[#\r\n]/u.test(search) ||
      (search && !search.startsWith("?"))
    )
      throw bridgeError("game_route_unavailable");
    if (signal?.aborted) throw bridgeError("bridge_offline");

    let agent;
    let mutationConnectionId = null;
    const mutationAdmissionIsCurrent = async () => {
      if (!mutationAdmission) return true;
      if (
        typeof bindMutationConnection !== "function" ||
        typeof mutationConnectionId !== "string"
      )
        return false;
      try {
        return (
          (await bindMutationConnection({
            admission: mutationAdmission,
            connectionId: mutationConnectionId,
            route,
          })) === true
        );
      } catch {
        return false;
      }
    };
    try {
      agent = new AgentClass({
        connections: 1,
        pipelining: 0,
        connect: createGameTlsDuplexConnector({
          openTunnel: () =>
            (async () => {
              const tunnel = await openStream({ route, signal });
              if (mutationAdmission) {
                const connectionId = tunnel?.bridgeConnectionId;
                if (
                  typeof bindMutationConnection !== "function" ||
                  typeof connectionId !== "string" ||
                  !(await bindMutationConnection({
                    admission: mutationAdmission,
                    connectionId,
                    route,
                  }))
                ) {
                  tunnel?.destroy?.();
                  throw bridgeError("bridge_mutation_not_admitted");
                }
                mutationConnectionId = connectionId;
              }
              return tunnel;
            })(),
          validateTunnel: mutationAdmission ? mutationAdmissionIsCurrent : null,
          ...(tlsConnect ? { tlsConnect } : {}),
        }),
      });
      if (typeof agent.compose !== "function")
        throw bridgeError("bridge_decompression_unavailable");
      // The body limit applies after decoding; never fall back to raw compressed data.
      const dispatcher = agent.compose(
        interceptors.decompress({
          maxSize: MAX_GAME_RESPONSE_BODY_BYTES,
          skipErrorResponses: false,
        }),
      );
      const upstream = await requestFn(
        `${CARGO_ORIGIN}${upstreamPath}${search}`,
        {
          method,
          headers: Object.fromEntries(headers),
          ...(body == null ? {} : { body }),
          ...(signal ? { signal } : {}),
          dispatcher,
          maxRedirections: 0,
        },
      );
      const headersForResponse = responseHeaders(upstream.headers);
      if (method === "HEAD" || BODYLESS_STATUSES.has(upstream.statusCode)) {
        // Discarding an Undici response body can emit AbortError asynchronously.
        upstream.body.on("error", () => {});
        upstream.body.destroy();
        if (mutationAdmission && !(await mutationAdmissionIsCurrent()))
          throw bridgeError("bridge_mutation_outcome_unknown");
        disposeAgent(agent);
        return new Response(null, {
          status: upstream.statusCode,
          headers: headersForResponse,
        });
      }
      const nodeBody = upstream.body;
      const declaredContentLength = Number(
        upstream.headers?.["content-length"],
      );
      if (
        Number.isSafeInteger(declaredContentLength) &&
        declaredContentLength > MAX_GAME_RESPONSE_BODY_BYTES
      ) {
        nodeBody.on("error", () => {});
        nodeBody.destroy();
        throw bridgeError("bridge_response_too_large");
      }
      let responseBody = boundedResponseBody(nodeBody, agent);
      if (mutationAdmission) {
        const reader = responseBody.getReader();
        responseBody = new ReadableStream({
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (!done) {
                controller.enqueue(value);
                return;
              }
              if (!(await mutationAdmissionIsCurrent())) {
                controller.error(
                  bridgeError("bridge_mutation_outcome_unknown"),
                );
                return;
              }
              controller.close();
            } catch (error) {
              controller.error(error);
            }
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        });
      }
      return new Response(responseBody, {
        status: upstream.statusCode,
        headers: headersForResponse,
      });
    } catch (error) {
      if (agent) disposeAgent(agent);
      if (error?.code === "bridge_response_too_large") throw error;
      throw bridgeError("bridge_transport_failed");
    }
  };
}
