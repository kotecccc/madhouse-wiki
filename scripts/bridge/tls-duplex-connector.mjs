import { connect as connectTls } from "node:tls";

export const CARGO_HOST = "cargohustle.online";
export const CARGO_PORT = 443;
const TLS_HANDSHAKE_TIMEOUT_MS = 17_000;
const TUNNEL_OPEN_TIMEOUT_MS = 25_000;

function transportError(code) {
  return Object.assign(new Error(code), { code });
}

const TLS_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_UNEXPECTED_EOF_WHILE_READING",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "data_channel_closed",
  "invalid_data_channel_frame",
  "data_frame_too_large",
  "backpressure_limit",
]);

function reportTlsFailure(error) {
  // The OpenSSL message may contain peer data. Record only a known error code.
  console.warn(
    "madhouse-bridge-tls-handshake",
    TLS_ERROR_CODES.has(error?.code) ? error.code : "other",
  );
}

function isDuplex(value) {
  return (
    value &&
    typeof value.on === "function" &&
    typeof value.write === "function" &&
    typeof value.end === "function" &&
    typeof value.destroy === "function"
  );
}

/**
 * Adapt one already-open byte tunnel into the verified TLS socket Undici expects.
 * Production callers do not pass hostname, CA, or destination overrides: Cargo's
 * host and port are compiled into this module. Dependency injection is retained
 * only for the synthetic local HTTPS test harness.
 */
export function createGameTlsDuplexConnector({
  openTunnel,
  tlsConnect = connectTls,
  validateTunnel = null,
  requestInfo = null,
  signal = null,
  onReady = () => {},
  onTunnel = () => {},
} = {}) {
  if (typeof openTunnel !== "function" || typeof tlsConnect !== "function")
    throw new TypeError("invalid_connector_dependencies");
  if (validateTunnel !== null && typeof validateTunnel !== "function")
    throw new TypeError("invalid_tunnel_validator");

  return (options, callback) => {
    let callbackCalled = false;
    let tlsSocket;
    let tunnel;
    let connectTimer;
    const finish = (error, socket = null) => {
      if (callbackCalled) return;
      callbackCalled = true;
      clearTimeout(connectTimer);
      signal?.removeEventListener("abort", abort);
      callback(error, socket);
    };
    const abort = () => {
      finish(transportError("bridge_cancelled"));
      tlsSocket?.destroy();
      tunnel?.destroy?.();
    };
    if (signal?.aborted) {
      abort();
      return null;
    }
    signal?.addEventListener("abort", abort, { once: true });

    if (
      options?.protocol !== "https:" ||
      options?.hostname !== CARGO_HOST ||
      Number(options?.port || CARGO_PORT) !== CARGO_PORT ||
      options?.httpSocket
    ) {
      finish(transportError("target_forbidden"));
      return null;
    }

    connectTimer = setTimeout(() => {
      finish(transportError("bridge_timeout"));
      tunnel?.destroy?.();
    }, TUNNEL_OPEN_TIMEOUT_MS);
    connectTimer.unref?.();
    try {
      tunnel = openTunnel();
    } catch {
      finish(transportError("bridge_offline"));
      return null;
    }
    const startTls = (resolvedTunnel) => {
      if (callbackCalled) {
        resolvedTunnel?.destroy?.();
        return;
      }
      tunnel = resolvedTunnel;
      if (!isDuplex(tunnel)) {
        tunnel?.destroy?.();
        finish(transportError("invalid_tunnel"));
        return;
      }

      try {
        onTunnel(tunnel);
      } catch {
        tunnel.destroy();
        finish(transportError("invalid_tunnel"));
        return;
      }

      try {
        tlsSocket = tlsConnect({
          socket: tunnel,
          servername: CARGO_HOST,
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          ALPNProtocols: ["http/1.1"],
        });
      } catch (error) {
        reportTlsFailure(error);
        tunnel.destroy();
        finish(transportError("tls_failed"));
        return;
      }

      clearTimeout(connectTimer);
      connectTimer = setTimeout(
        () => failHandshake("tls_timeout"),
        TLS_HANDSHAKE_TIMEOUT_MS,
      );
      connectTimer.unref?.();
      tlsSocket.once("secureConnect", () => {
        if (tlsSocket.authorized !== true) {
          failHandshake("tls_peer_unverified");
          return;
        }
        if (tlsSocket.alpnProtocol && tlsSocket.alpnProtocol !== "http/1.1") {
          failHandshake("tls_protocol_rejected");
          return;
        }
        Promise.resolve()
          .then(() => validateTunnel?.({ tunnel }) ?? true)
          .then(
            (valid) => {
              if (callbackCalled) return;
              if (valid !== true || signal?.aborted) {
                failHandshake("bridge_mutation_not_admitted");
                return;
              }
              if (
                requestInfo &&
                tunnel.socket?.bridgeRequestLog &&
                tunnel.socket.readyState === 1
              ) {
                const { method, path } = requestInfo;
                const pathname =
                  typeof path === "string" ? path.split("?", 1)[0] : "";
                if (
                  /^(GET|POST|PUT|DELETE)$/.test(method) &&
                  /^\/api\/[A-Za-z0-9_/$%.-]{1,250}$/.test(pathname)
                )
                  try {
                    tunnel.socket.send(
                      JSON.stringify({
                        type: "request",
                        method,
                        path: pathname,
                      }),
                      { binary: false },
                      () => {},
                    );
                  } catch {
                    /* Optional diagnostics must not block game traffic. */
                  }
              }
              onReady();
              finish(null, tlsSocket);
            },
            () => failHandshake("bridge_mutation_not_admitted"),
          );
      });
      tlsSocket.once("error", (error) => {
        if (!callbackCalled) reportTlsFailure(error);
        finish(transportError("tls_failed"));
      });
      tlsSocket.once("close", () => {
        if (!callbackCalled) finish(transportError("tls_closed_before_ready"));
      });
    };

    const failHandshake = (code) => {
      const error = transportError(code);
      finish(error);
      tlsSocket?.destroy(error);
      if (!tlsSocket) tunnel?.destroy?.();
    };

    if (tunnel && typeof tunnel.then === "function")
      Promise.resolve(tunnel).then(startTls, () => {
        finish(transportError("bridge_offline"));
      });
    else startTls(tunnel);

    return tlsSocket || null;
  };
}
