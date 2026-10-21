import { useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import {
  createConnectorBridge,
  CONNECTION_EPOCH_KEY,
} from "../../../../shared/telegram-connector.js";
import {
  telegramContext,
  accountStorageKey,
} from "../../../../shared/telegram-context.js";
import { connectorOrigin } from "../../../../connector/protocol.js";
import "./TelegramConnection.css";

export const TELEGRAM_CONNECTOR_ORIGIN = connectorOrigin(
  import.meta.env.VITE_TELEGRAM_CONNECTOR_ORIGIN,
);

export function TelegramConnection({
  ref,
  open,
  onClose,
  onToken,
  onWarning,
  onEmpty,
  onRetry,
  error,
  sessionStatus,
  autoConnect,
}) {
  const bridge = useRef(null),
    iframe = useRef(null),
    interactiveActive = useRef(false),
    callbacks = useRef({ onToken, onClose, onWarning });
  callbacks.current = { onToken, onClose, onWarning, onEmpty };
  const request = useCallback(async (interactive) => {
    if (!bridge.current) throw new Error("connection_unavailable");
    if (!interactive && interactiveActive.current) return { status: "pending" };
    let epoch;
    try {
      epoch = window.localStorage.getItem(
        accountStorageKey(CONNECTION_EPOCH_KEY),
      );
    } catch {
      /* WebView storage may be disabled. */
    }
    const context = telegramContext();
    if (context.isTelegram && !context.initData)
      throw new Error("wiki_reopen_required");
    if (interactive) interactiveActive.current = true;
    let result;
    try {
      result = await bridge.current.request("connect-game", {
        expectedUserId: context.userId,
        wikiInitData: context.initData,
        interactive,
      });
    } finally {
      if (interactive) interactiveActive.current = false;
    }
    let currentEpoch;
    try {
      currentEpoch = window.localStorage.getItem(
        accountStorageKey(CONNECTION_EPOCH_KEY),
      );
    } catch {
      /* unavailable */
    }
    if (epoch !== currentEpoch || context.userId !== telegramContext().userId)
      throw new Error("cancelled");
    if (result.status === "connected")
      callbacks.current.onToken(result.accessToken);
    else if (result.status === "login-required") callbacks.current.onEmpty?.();
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
      logout: () =>
        bridge.current?.request("logout", {
          expectedUserId: telegramContext().userId,
          wikiInitData: telegramContext().initData,
        }),
    }),
    [request],
  );
  useEffect(() => {
    if (!autoConnect && !telegramContext().initData) return;
    const restore = () =>
      request(false).catch(() => {
        /* Never open a login prompt from background restoration. */
      });
    restore();
    const focus = () => {
      if (!document.hidden) restore();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    const timer = setInterval(focus, 60000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
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
