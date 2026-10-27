import { ErrorToast } from "../../../components/ui/ErrorToast/ErrorToast.jsx";
import { projectLevelProgress } from "../../../../shared/profile-progress.js";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { signalAuthRestoreSettled } from "../../../../shared/auth-session.js";
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
  onBack,
  onToken,
  onWarning,
  onEmpty,
  onRetry,
  error,
  autoConnect,
  onPending,
  onRestoreSettled,
}) {
  const [uiState, setUiState] = useState(null);
  const viewportHeight =
    typeof window === "undefined" ? 800 : window.innerHeight;
  const bridge = useRef(null),
    iframe = useRef(null),
    interactiveActive = useRef(false),
    restoreAttempted = useRef(false),
    requestedFooterFor = useRef(null),
    callbacks = useRef({ onToken, onClose, onWarning });
  callbacks.current = {
    onToken,
    onClose,
    onWarning,
    onEmpty,
    onPending,
    onRestoreSettled,
  };
  const request = useCallback(
    async (interactive, { progressOnly = false, expectedUserId } = {}) => {
      if (!bridge.current) throw new Error("connection_unavailable");
      if (interactive) restoreAttempted.current = true;
      if (!interactive && interactiveActive.current)
        return { status: "pending" };
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
      const requestedUserId =
        context.userId ??
        (progressOnly ? String(expectedUserId ?? "") : undefined);
      if (
        progressOnly &&
        (!/^[1-9][0-9]{0,19}$/.test(requestedUserId || "") ||
          (context.userId && context.userId !== String(expectedUserId)))
      )
        throw new Error("invalid_progress_identity");
      if (interactive) interactiveActive.current = true;
      let result;
      try {
        result = await bridge.current.request("connect-game", {
          expectedUserId: requestedUserId,
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
      if (progressOnly)
        return {
          status: result.status,
          ...(projectLevelProgress(result) || {}),
        };
      if (result.status === "connected")
        callbacks.current.onToken(
          result.accessToken,
          result.playerLevel,
          result.currentExp,
          result.expToNextLevel,
          result.activeBossBattle,
        );
      else if (result.status === "login-required")
        callbacks.current.onEmpty?.();
      else if (result.status === "pending") callbacks.current.onPending?.();
      return result;
    },
    [],
  );
  const attach = useCallback((node) => {
    if (!node || iframe.current === node) return;
    iframe.current = node;
    bridge.current?.destroy();
    bridge.current = createConnectorBridge({
      origin: TELEGRAM_CONNECTOR_ORIGIN,
      source: () => node.contentWindow,
      listen: (listener) => window.addEventListener("message", listener),
      unlisten: (listener) => window.removeEventListener("message", listener),
      onUiState: (value) => {
        setUiState(value);
      },
      onRevocationFailure: () => callbacks.current.onWarning?.(),
    });
  }, []);
  useEffect(() => {
    if (
      !open ||
      !uiState?.requestId ||
      uiState.hostedControls ||
      requestedFooterFor.current === uiState.requestId
    )
      return;
    requestedFooterFor.current = uiState.requestId;
    bridge.current?.uiAction("enable-footer", uiState.requestId);
  }, [open, uiState?.requestId, uiState?.hostedControls]);
  useImperativeHandle(
    ref,
    () => ({
      connect: () => request(true),
      restore: () => request(false),
      refreshProgress: (expectedUserId) =>
        request(false, { progressOnly: true, expectedUserId }),
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
    if (
      restoreAttempted.current ||
      (!autoConnect && !telegramContext().initData)
    )
      return;
    restoreAttempted.current = true;
    const restore = async () => {
      try {
        const result = await request(false);
        if (result.status !== "connected") {
          callbacks.current.onRestoreSettled?.();
          signalAuthRestoreSettled();
        }
      } catch {
        /* Never open a login prompt from background restoration. */
        callbacks.current.onRestoreSettled?.();
        signalAuthRestoreSettled();
      }
    };
    restore();
  }, [autoConnect, request]);
  useEffect(
    () => () => bridge.current?.destroy({ preserveRemoteSession: true }),
    [],
  );
  if (!TELEGRAM_CONNECTOR_ORIGIN) return null;
  const sendUiAction = (command) => {
    if (uiState?.requestId)
      bridge.current?.uiAction(command, uiState.requestId);
  };
  const actions = (
    <div
      className={`telegram-connection-actions telegram-connection-actions--${
        uiState?.stage || "loading"
      }`}
      aria-busy={uiState?.busy || undefined}
    >
      {uiState?.stage !== "consent" && (
        <Button
          variant="secondary"
          disabled={uiState?.busy}
          onClick={
            !uiState || ["consent", "wrong-account"].includes(uiState.stage)
              ? onBack
              : () => sendUiAction("back")
          }
        >
          Назад
        </Button>
      )}
      {uiState?.hostedControls && uiState.stage === "consent" && (
        <>
          <Button
            variant="primary"
            disabled={uiState.busy}
            onClick={() => sendUiAction("choose-phone")}
          >
            Войти по номеру
          </Button>
          <Button
            variant="secondary"
            disabled={uiState.busy}
            onClick={() => sendUiAction("choose-qr")}
          >
            Войти по QR
          </Button>
        </>
      )}
      {uiState?.hostedControls &&
        ["phone", "code", "password"].includes(uiState.stage) && (
          <Button
            variant="primary"
            disabled={uiState.busy || !uiState.canSubmit}
            onClick={() => sendUiAction("submit")}
          >
            {uiState.stage === "phone"
              ? "Получить код"
              : uiState.stage === "code"
                ? "Подтвердить вход"
                : "Подтвердить"}
          </Button>
        )}
      {uiState?.hostedControls && uiState.stage === "wrong-account" && (
        <Button
          variant="primary"
          disabled={uiState.busy}
          onClick={() => sendUiAction("logout")}
        >
          Отключить этот аккаунт
        </Button>
      )}
      {error && (
        <Button variant="primary" onClick={onRetry}>
          Повторить подключение
        </Button>
      )}
      {uiState?.hostedControls && uiState.stage === "retry" && !error && (
        <Button variant="primary" onClick={onRetry}>
          Повторить подключение
        </Button>
      )}
    </div>
  );
  return (
    <Modal
      title="Вход через Telegram"
      loading={Boolean(
        open &&
        !error &&
        (!uiState || uiState.busy || uiState.stage === "loading"),
      )}
      titleId="telegram-connection-title"
      width={440}
      contentScrollable={uiState?.stage !== "consent"}
      visible={open}
      onClose={() => {
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
        style={{
          height: `${Math.min(
            uiState?.height || 120,
            Math.max(120, Math.floor(viewportHeight * 0.66)),
          )}px`,
        }}
      />
      <ErrorToast message={error} />
      {actions}
    </Modal>
  );
}
