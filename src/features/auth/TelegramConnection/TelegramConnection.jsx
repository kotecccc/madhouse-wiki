import { useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import {
  createConnectorBridge,
  CONNECTION_EPOCH_KEY,
  telegramUserHint,
} from "../../../../shared/telegram-connector.js";
import { connectorOrigin } from "../../../../connector/protocol.js";
import "./TelegramConnection.css";

export const TELEGRAM_CONNECTOR_ORIGIN = connectorOrigin(
  import.meta.env.VITE_TELEGRAM_CONNECTOR_ORIGIN,
);
const EXPECTED_TELEGRAM_USER = telegramUserHint(
  typeof window === "undefined" ? undefined : window,
);

export function TelegramConnection({
  ref,
  open,
  onClose,
  onToken,
  onWarning,
  onRetry,
  error,
  sessionStatus,
  autoConnect,
}) {
  const bridge = useRef(null),
    iframe = useRef(null),
    callbacks = useRef({ onToken, onClose, onWarning });
  callbacks.current = { onToken, onClose, onWarning };
  const request = useCallback(async (interactive) => {
    if (!bridge.current) throw new Error("connection_unavailable");
    const epoch = window.localStorage.getItem(CONNECTION_EPOCH_KEY);
    const result = await bridge.current.request("connect-game", {
      expectedUserId: EXPECTED_TELEGRAM_USER,
      interactive,
    });
    if (epoch !== window.localStorage.getItem(CONNECTION_EPOCH_KEY))
      throw new Error("cancelled");
    if (result.status === "connected")
      callbacks.current.onToken(result.accessToken);
    return result;
  }, []);
  const attach = useCallback((node) => {
    if (!node || iframe.current === node) return;
    iframe.current = node;
    bridge.current?.destroy();
    bridge.current = createConnectorBridge({
      origin: TELEGRAM_CONNECTOR_ORIGIN,
      source: () => node.contentWindow,
      listen: (listener) => window.addEventListener("message", listener),
      unlisten: (listener) => window.removeEventListener("message", listener),
      onRevocationFailure: () => callbacks.current.onWarning?.(),
    });
  }, []);
  useImperativeHandle(
    ref,
    () => ({
      connect: () => request(true),
      restore: () => request(false),
      cancel: () => bridge.current?.cancel(),
      logout: () => bridge.current?.request("logout"),
    }),
    [request],
  );
  useEffect(() => {
    if (
      !autoConnect ||
      !["empty", "expired", "invalid"].includes(sessionStatus)
    )
      return;
    request(false).catch(() => {
      /* Background restoration never opens a login prompt. */
    });
  }, [autoConnect, sessionStatus, request]);
  useEffect(() => () => bridge.current?.destroy(), []);
  if (!TELEGRAM_CONNECTOR_ORIGIN) return null;
  return (
    <Modal
      title="Вход через Telegram"
      titleId="telegram-connection-title"
      width={440}
      visible={open}
      onClose={() => {
        bridge.current?.cancel();
        onClose();
      }}
    >
      <iframe
        ref={attach}
        className="telegram-connection-frame"
        title="Подключение игрового аккаунта через Telegram"
        src={TELEGRAM_CONNECTOR_ORIGIN + "/"}
        referrerPolicy="origin"
        sandbox="allow-scripts allow-same-origin allow-forms"
      />
      {error && (
        <div className="telegram-connection-retry">
          <p className="login-connection-error" role="alert">
            {error}
          </p>
          <Button variant="secondary" onClick={onRetry}>
            Повторить подключение
          </Button>
        </div>
      )}
    </Modal>
  );
}
