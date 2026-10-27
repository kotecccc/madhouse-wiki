import { useCallback, useEffect, useState } from "react";
import { parseInternalResponse } from "../../../../scripts/bridge/protocol-v1/internal-api.mjs";
import {
  accountStorageKey,
  telegramContext,
} from "../../../../shared/telegram-context.js";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { FieldLabel } from "../../../components/ui/FieldLabel/FieldLabel.jsx";
import { Input } from "../../../components/ui/Input/Input.jsx";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { createRestoreApi } from "./restore-api.js";
import "./DeviceManagerDialog.css";

const ERROR_TEXT = Object.freeze({
  invalid_request: "Проверьте введённые данные.",
  not_authorized: "Не удалось подтвердить владельца устройства.",
  pairing_not_found: "Заявка не найдена или уже закрыта.",
  pairing_expired:
    "Срок действия кода истёк. Запросите новый код на компьютере.",
  pairing_code_invalid: "Код не совпал. Проверьте его в приложении.",
  device_already_registered: "Это устройство уже зарегистрировано.",
  device_limit_reached: "Сначала отключите текущее устройство.",
  device_history_limit_reached:
    "Список устройств заполнен. Обратитесь в поддержку.",
  device_generation_conflict: "Список устройств изменился. Обновите его.",
  game_account_binding_required:
    "Сначала свяжите игровой профиль с аккаунтом Telegram.",
  invalid_game_session:
    "Не удалось проверить игровой профиль. Войдите в игру заново и попробуйте ещё раз.",
  game_account_mismatch:
    "Telegram в игровом профиле не совпадает с этим аккаунтом Wiki.",
  game_account_binding_conflict:
    "К этому Telegram аккаунту уже привязан другой игровой профиль.",
  game_account_already_bound:
    "Этот игровой профиль уже привязан к другому аккаунту Wiki.",
  game_account_binding_unavailable:
    "Не удалось проверить профиль игры. Попробуйте позже.",
  rate_limited: "Слишком много запросов. Попробуйте позже.",
  telegram_session_required: "Откройте Wiki через Telegram и войдите заново.",
  bridge_owner_auth_unavailable: "Управление устройствами временно недоступно.",
  game_auth_busy: "Предыдущий вход ещё выполняется. Обновите статус.",
  game_auth_generation_conflict:
    "Не удалось обновить поколение согласия. Обновите список и попробуйте снова.",
  game_auth_operation_not_found:
    "Операция входа не найдена. Начните её заново.",
  game_auth_unavailable: "Продление игрового входа временно недоступно.",
  route_selection_unavailable:
    "Переключение маршрута пока недоступно. Попробуйте позже.",
  route_selection_pause_failed:
    "Не удалось безопасно остановить автоматизацию. Маршрут не изменён.",
  route_epoch_conflict:
    "Маршрут уже изменился. Обновите список устройств и попробуйте снова.",
  route_stale: "Маршрут через компьютер изменился. Обновите список устройств.",
  credential_unavailable:
    "Сохранённый игровой вход недоступен. Начните новый вход.",
  bridge_unavailable: "Не удалось связаться с сервером Wiki.",
});

const AUTH_OPERATION_KEY = "madhouse-game-auth-operation";
const restoreApi = createRestoreApi();
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACTIVE_AUTH_STATES = new Set([
  "created",
  "launch_requested",
  "exchange_pending",
  "verification_pending",
  "credential_stored",
  "logout_pending",
]);

function authOperationText(operation) {
  if (!operation) return "";
  if (operation.status === "logout_pending")
    return "Закрываем игровой вход Wiki и удаляем сохранённые полномочия…";
  if (operation.status === "logged_out")
    return "Игровой вход Wiki закрыт. Cargo-сессия остаётся активной; новый вход потребует вашего подтверждения.";
  if (operation.status === "auth_outcome_unknown")
    return operation.reason === "consent_required"
      ? "Операция отменена после начала обмена. Cargo мог создать сессию; новая попытка может создать ещё одну."
      : "Cargo не подтвердил результат. Повторный вход начнётся только после вашего нового подтверждения.";
  if (operation.status === "failed") {
    if (operation.reason === "device_offline")
      return "Компьютер не ответил. Подключите его и попробуйте снова.";
    if (operation.reason === "route_stale")
      return "Маршрут через компьютер изменился. Обновите устройства.";
    if (operation.reason === "invalid_game_session")
      return "Cargo отклонил данные входа. Запустите игру заново и повторите.";
    return "Не удалось обновить игровой вход. Можно начать новую попытку.";
  }
  return (
    {
      created: "Запрос создан.",
      launch_requested: "Ожидаем подтверждённые данные запуска с компьютера…",
      exchange_pending: "Обмениваем данные запуска на игровой вход…",
      verification_pending: "Проверяем игровой профиль через компьютер…",
      credential_stored: "Вход сохранён, завершаем подключение аккаунта…",
      ready: "Игровой вход обновлён.",
      cancelled: "Запрос отменён.",
    }[operation.status] || ""
  );
}

function waitForNextStatus(signal) {
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, 1500);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function operationRequestId() {
  return crypto.randomUUID();
}

async function callBridge(operation, fields, initData, signal) {
  const requestId = operationRequestId();
  const headers = { "content-type": "application/json" };
  const response = await fetch("/api/bridge", {
    method: "POST",
    headers,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal,
    body: JSON.stringify({ operation, requestId, ...fields, initData }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const message = Object.hasOwn(ERROR_TEXT, result?.error)
      ? ERROR_TEXT[result.error]
      : "Не удалось выполнить запрос.";
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  try {
    parseInternalResponse(result);
  } catch {
    throw new Error("Сервер вернул некорректный ответ.");
  }
  if (result.requestId !== requestId || result.operation !== operation)
    throw new Error("Сервер вернул ответ для другого запроса.");
  return result;
}

function statusLabel(status) {
  return status === "active" ? "Зарегистрировано" : "Отключено";
}

export function DeviceManagerDialog({ open, onClose, onRestoreConnect }) {
  const [devices, setDevices] = useState([]);
  const [gameAccountBound, setGameAccountBound] = useState(null);
  const [routePolicy, setRoutePolicy] = useState(null);
  const [authOperationId, setAuthOperationId] = useState("");
  const [authOperation, setAuthOperation] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [pairingId, setPairingId] = useState("");
  const [matchingCode, setMatchingCode] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [initData, setInitData] = useState("");
  const [restoreStatus, setRestoreStatus] = useState(null);
  const [restoreBusy, setRestoreBusy] = useState(false);

  const loadDevices = useCallback(async (currentInitData, signal) => {
    setLoading(true);
    setMessage("");
    try {
      const result = await callBridge(
        "device.list",
        {},
        currentInitData,
        signal,
      );
      setDevices(result.devices);
      setGameAccountBound(result.routePolicy !== null);
      setRoutePolicy(result.routePolicy);
    } catch (error) {
      if (!signal?.aborted)
        setMessage(error.message || "Не удалось загрузить список устройств.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const context = telegramContext();
    setInitData(context.initData);
    setDevices([]);
    setGameAccountBound(null);
    setRoutePolicy(null);
    setRestoreStatus(null);
    let savedOperationId = "";
    try {
      const stored = window.sessionStorage.getItem(
        accountStorageKey(AUTH_OPERATION_KEY),
      );
      if (stored && UUID_PATTERN.test(stored)) savedOperationId = stored;
    } catch {
      // Operation IDs are only a view pointer; the server owns auth state.
    }
    setAuthOperationId(savedOperationId);
    setAuthOperation(null);
    if (!context.initData) {
      setDevices([]);
      setGameAccountBound(null);
      setRoutePolicy(null);
      setMessage(ERROR_TEXT.telegram_session_required);
      return undefined;
    }
    const controller = new AbortController();
    void loadDevices(context.initData, controller.signal);
    void restoreApi
      .status(context.initData, controller.signal)
      .then((status) => {
        if (!controller.signal.aborted) setRestoreStatus(status);
      })
      .catch(() => {
        if (!controller.signal.aborted) setRestoreStatus("unavailable");
      });
    return () => controller.abort();
  }, [loadDevices, open]);

  useEffect(() => {
    if (
      !open ||
      !initData ||
      initData !== telegramContext().initData ||
      !authOperationId
    )
      return undefined;
    const controller = new AbortController();
    const signal = controller.signal;
    async function pollStatus() {
      try {
        for (let attempt = 0; attempt < 40 && !signal.aborted; attempt++) {
          const result = await callBridge(
            "game_auth.status",
            { operationId: authOperationId },
            initData,
            signal,
          );
          if (signal.aborted) return;
          setAuthOperation(result);
          if (!ACTIVE_AUTH_STATES.has(result.status)) return;
          await waitForNextStatus(signal);
        }
        if (!signal.aborted)
          setMessage("Запрос ещё выполняется. Обновите статус входа.");
      } catch (error) {
        if (!signal.aborted)
          setMessage(error.message || "Не удалось обновить статус входа.");
      }
    }
    void pollStatus();
    return () => controller.abort();
  }, [authOperationId, initData, open]);

  async function approve(event) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    try {
      const result = await callBridge(
        "device.pair.approve",
        {
          pairingId: pairingId.trim(),
          matchingCode: matchingCode.trim().toUpperCase(),
        },
        initData,
      );
      setPairingId("");
      setMatchingCode("");
      setMessage(
        result.status === "already_approved"
          ? "Это устройство уже подтверждено."
          : "Компьютер подключён к вашему профилю.",
      );
      await loadDevices(initData);
    } catch (error) {
      setMessage(error.message || "Не удалось подтвердить устройство.");
    } finally {
      setLoading(false);
    }
  }

  async function confirmRestoreReview() {
    if (restoreStatus !== "review_required" || !initData || restoreBusy) return;
    setRestoreBusy(true);
    setMessage("");
    try {
      const status = await restoreApi.review(initData);
      setRestoreStatus(status);
      setMessage(
        status === "ready"
          ? "Проверка состояния подтверждена. Автоматизации остаются остановленными."
          : "Проверка подтверждена. Неизвестные действия ещё требуют сверки; новые действия заблокированы.",
      );
    } catch {
      setMessage(
        "Не удалось подтвердить проверку. Обновите состояние и попробуйте снова.",
      );
    } finally {
      setRestoreBusy(false);
    }
  }

  async function startDirectRestore() {
    if (
      restoreStatus !== "reauthorization_required" ||
      !initData ||
      restoreBusy ||
      typeof onRestoreConnect !== "function"
    )
      return;
    setRestoreBusy(true);
    setMessage("");
    try {
      const requestId = await restoreApi.beginDirect(initData);
      onRestoreConnect(requestId);
    } catch {
      setMessage(
        "Не удалось начать восстановление. Откройте Wiki заново через Telegram и попробуйте ещё раз.",
      );
    } finally {
      setRestoreBusy(false);
    }
  }
  async function resumeRestore() {
    if (
      ![
        "auth_ready_to_resume",
        "auth_check_saved",
        "auth_outcome_unknown",
      ].includes(restoreStatus) ||
      !initData ||
      restoreBusy
    )
      return;
    setRestoreBusy(true);
    setMessage("");
    try {
      setRestoreStatus(await restoreApi.resume(initData));
    } catch {
      setMessage(
        "Не удалось продолжить проверку сохранённого входа. Попробуйте позже.",
      );
    } finally {
      setRestoreBusy(false);
    }
  }
  async function cancelPreparedRestore() {
    if (restoreStatus !== "auth_prepared" || !initData || restoreBusy) return;
    setRestoreBusy(true);
    setMessage("");
    try {
      setRestoreStatus(await restoreApi.cancelPrepared(initData));
    } catch {
      setMessage(
        "Не удалось отменить подготовленный вход. Обновите состояние и попробуйте позже.",
      );
    } finally {
      setRestoreBusy(false);
    }
  }

  async function acknowledgeUnknownRestore() {
    if (
      !["auth_outcome_unknown", "auth_pending"].includes(restoreStatus) ||
      !initData ||
      restoreBusy
    )
      return;
    setRestoreBusy(true);
    setMessage("");
    try {
      setRestoreStatus(await restoreApi.acknowledgeUnknown(initData));
    } catch {
      setMessage(
        "Не удалось подтвердить новый вход. Сначала проверьте сохранённый результат или попробуйте позже.",
      );
    } finally {
      setRestoreBusy(false);
    }
  }

  async function startGameAuth() {
    if (routePolicy?.policy !== "bridge_required") return;
    setAuthBusy(true);
    setMessage("");
    try {
      const result = await callBridge(
        "game_auth.start",
        {
          consentGeneration: Date.now(),
          routeEpoch: routePolicy.routeEpoch,
        },
        initData,
      );
      try {
        window.sessionStorage.setItem(
          accountStorageKey(AUTH_OPERATION_KEY),
          result.operationId,
        );
      } catch {
        // Losing this view pointer cannot interrupt server-owned auth recovery.
      }
      setAuthOperationId(result.operationId);
      setAuthOperation(result);
    } catch (error) {
      setMessage(error.message || "Не удалось начать игровой вход.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function refreshGameAuthStatus() {
    if (!authOperationId) return;
    setAuthBusy(true);
    setMessage("");
    try {
      const result = await callBridge(
        "game_auth.status",
        { operationId: authOperationId },
        initData,
      );
      setAuthOperation(result);
    } catch (error) {
      setMessage(error.message || "Не удалось обновить статус входа.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function cancelGameAuth() {
    if (!authOperationId) return;
    setAuthBusy(true);
    setMessage("");
    try {
      const result = await callBridge(
        "game_auth.cancel",
        { operationId: authOperationId },
        initData,
      );
      setAuthOperation(result);
    } catch (error) {
      setMessage(error.message || "Не удалось отменить игровой вход.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function logoutGameAuth() {
    setAuthBusy(true);
    setMessage("");
    try {
      const result = await callBridge("game_auth.logout", {}, initData);
      try {
        window.sessionStorage.setItem(
          accountStorageKey(AUTH_OPERATION_KEY),
          result.operationId,
        );
      } catch {
        // Server-side logout remains durable if the view pointer cannot be saved.
      }
      setAuthOperationId(result.operationId);
      setAuthOperation(result);
    } catch (error) {
      setMessage(error.message || "Не удалось закрыть игровой вход Wiki.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function revoke(device) {
    setLoading(true);
    setMessage("");
    try {
      await callBridge(
        "device.revoke",
        {
          deviceId: device.deviceId,
          expectedGeneration: device.generation,
        },
        initData,
      );
      setMessage(`Устройство «${device.deviceName}» отключено.`);
      await loadDevices(initData);
    } catch (error) {
      setMessage(error.message || "Не удалось отключить устройство.");
    } finally {
      setLoading(false);
    }
  }

  async function selectDevice(device) {
    if (
      !routePolicy ||
      device.status !== "active" ||
      routePolicy.activeDeviceId === device.deviceId
    )
      return;
    setLoading(true);
    setMessage(
      `Переключаем маршрут Wiki на «${device.deviceName}». Автоматизации будут остановлены и не запустятся сами после переключения.`,
    );
    try {
      const result = await callBridge(
        "route.select",
        {
          policy: "bridge_required",
          activeDeviceId: device.deviceId,
          expectedRouteEpoch: routePolicy.routeEpoch,
        },
        initData,
      );
      setRoutePolicy({
        ...routePolicy,
        policy: result.policy,
        activeDeviceId: device.deviceId,
        routeEpoch: result.routeEpoch,
      });
      setMessage(
        `Маршрут Wiki переключён на «${device.deviceName}». Подключите этот компьютер в Madhouse Connect, обновите игровой вход и вручную запустите нужные автоматизации.`,
      );
    } catch (error) {
      setMessage(error.message || "Не удалось переключить компьютер Wiki.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      title="Устройства"
      titleId="bridge-devices-title"
      visible={open}
      onClose={onClose}
      loading={loading}
    >
      <div className="device-manager-content">
        {restoreStatus &&
          restoreStatus !== "not_required" &&
          restoreStatus !== "ready" && (
            <BaseCard>
              <CardTitle as="h3">Восстановление аккаунта</CardTitle>
              <CardDescription>
                {restoreStatus === "review_required"
                  ? "Сверьте игровой профиль и состояние автоматизаций с игрой. Сохранённая копия могла не включать последние действия. После проверки подтвердите состояние; прежние автоматизации останутся остановленными."
                  : restoreStatus === "reconciliation_required"
                    ? "Некоторые действия имеют неизвестный результат. Новые игровые действия заблокированы до сверки."
                    : restoreStatus === "reauthorization_required"
                      ? "После восстановления требуется повторный вход и явный выбор маршрута."
                      : restoreStatus === "auth_pending"
                        ? "Запрос на вход мог быть отправлен и ещё выполняться. Если после перезапуска результат не появился, игра могла создать сессию. Проверьте активные сессии игры; новый вход может создать ещё одну."
                        : restoreStatus === "auth_prepared"
                          ? "Вход подготовлен, но запрос в игру ещё не отправлен. Можно отменить подготовку и начать заново."
                          : restoreStatus === "auth_ready_to_resume"
                            ? "Новый вход уже сохранён. Можно продолжить проверку профиля без повторного выпуска токена."
                            : restoreStatus === "auth_check_saved"
                              ? "Проверка входа прервалась. Можно проверить сохранённый результат без повторного входа; если записи нет, результат останется неизвестным."
                              : restoreStatus === "auth_outcome_unknown"
                                ? "Результат входа неизвестен: игра могла создать сессию. Сначала проверьте сохранённый результат и активные сессии игры. Новый вход может создать ещё одну сессию; он не начнётся без отдельного подтверждения маршрута."
                                : restoreStatus === "auth_failed"
                                  ? "Вход при восстановлении не завершился. Требуется проверка состояния перед новой попыткой."
                                  : "Не удалось получить состояние восстановления. Попробуйте открыть устройства позже."}
              </CardDescription>
              {restoreStatus === "review_required" && (
                <Button
                  variant="primary"
                  disabled={restoreBusy || !initData}
                  onClick={() => void confirmRestoreReview()}
                >
                  Я проверил состояние
                </Button>
              )}
              {restoreStatus === "auth_prepared" && (
                <Button
                  variant="secondary"
                  disabled={restoreBusy || !initData}
                  onClick={() => void cancelPreparedRestore()}
                >
                  Отменить подготовку
                </Button>
              )}
              {["auth_outcome_unknown", "auth_pending"].includes(
                restoreStatus,
              ) && (
                <Button
                  variant="warning"
                  disabled={restoreBusy || !initData}
                  onClick={() => void acknowledgeUnknownRestore()}
                >
                  Понимаю, разрешить новый вход
                </Button>
              )}
              {[
                "auth_ready_to_resume",
                "auth_check_saved",
                "auth_outcome_unknown",
              ].includes(restoreStatus) && (
                <Button
                  variant="primary"
                  disabled={restoreBusy || !initData}
                  onClick={() => void resumeRestore()}
                >
                  Продолжить проверку
                </Button>
              )}
              {restoreStatus === "reauthorization_required" &&
                typeof onRestoreConnect === "function" && (
                  <>
                    <CardDescription>
                      Выбирая прямое подключение, вы разрешаете Wiki обратиться
                      к игре со своего сервера для нового входа. Прежние
                      устройства и автоматизации не включатся автоматически.
                    </CardDescription>
                    <Button
                      variant="primary"
                      disabled={restoreBusy || !initData}
                      onClick={() => void startDirectRestore()}
                    >
                      Подтвердить прямое подключение и войти
                    </Button>
                  </>
                )}
            </BaseCard>
          )}
        <BaseCard className="device-manager-approval">
          <CardTitle as="h3">Подтвердить компьютер</CardTitle>
          <CardDescription>
            Введите идентификатор заявки и шестизначный код из Madhouse Connect.
          </CardDescription>
          <form className="device-manager-form" onSubmit={approve}>
            <div>
              <FieldLabel htmlFor="bridge-pairing-id">
                Идентификатор заявки
              </FieldLabel>
              <Input
                id="bridge-pairing-id"
                autoComplete="off"
                value={pairingId}
                onChange={(event) => setPairingId(event.target.value)}
                disabled={loading || !initData}
                required
              />
            </div>
            <div>
              <FieldLabel htmlFor="bridge-pairing-code">
                Код подтверждения
              </FieldLabel>
              <Input
                id="bridge-pairing-code"
                autoComplete="off"
                maxLength={6}
                value={matchingCode}
                onChange={(event) =>
                  setMatchingCode(event.target.value.toUpperCase())
                }
                disabled={loading || !initData}
                required
              />
            </div>
            <Button
              variant="primary"
              type="submit"
              disabled={loading || !initData}
            >
              Подтвердить
            </Button>
          </form>
        </BaseCard>

        {gameAccountBound === false && (
          <BaseCard className="device-manager-binding">
            <CardTitle as="h3">Связать игровой профиль</CardTitle>
            <CardDescription>
              Войдите в игровой аккаунт через Telegram в Wiki. При входе Wiki
              проверит профиль игры и свяжет его с вашим аккаунтом Telegram.
            </CardDescription>
          </BaseCard>
        )}

        {gameAccountBound === true && routePolicy?.policy === "direct" && (
          <CardDescription as="p">
            Wiki пока использует прямой маршрут. Выберите зарегистрированный
            компьютер ниже, чтобы запросить переключение на маршрут через
            Madhouse Connect. Регистрация не означает, что приложение сейчас
            запущено.
          </CardDescription>
        )}

        {gameAccountBound === true &&
          routePolicy?.policy === "bridge_required" && (
            <BaseCard className="device-manager-auth device-manager-binding">
              <CardTitle as="h3">Игровой вход через компьютер</CardTitle>
              <CardDescription>
                Нажатие кнопки подтверждает новый запрос входа. Wiki попросит
                подключённый Madhouse Connect получить данные запуска
                официального игрового бота и проверит профиль через тот же
                компьютер. Если результат окажется неизвестен, Cargo мог создать
                сессию; повтор запускается только вашим новым подтверждением.
              </CardDescription>
              {authOperation && (
                <CardDescription as="p" role="status">
                  {authOperationText(authOperation)}
                </CardDescription>
              )}
              <div className="device-manager-auth-actions">
                <Button
                  variant="primary"
                  disabled={loading || authBusy || !initData}
                  onClick={() => void startGameAuth()}
                >
                  {authOperation?.status === "auth_outcome_unknown"
                    ? "Подтвердить новый вход"
                    : "Начать или обновить вход"}
                </Button>
                {authOperationId && (
                  <Button
                    variant="secondary"
                    disabled={loading || authBusy || !initData}
                    onClick={() => void refreshGameAuthStatus()}
                  >
                    Обновить статус
                  </Button>
                )}
                {authOperation &&
                  ACTIVE_AUTH_STATES.has(authOperation.status) && (
                    <Button
                      variant="warning"
                      disabled={loading || authBusy || !initData}
                      onClick={() => void cancelGameAuth()}
                    >
                      Отменить
                    </Button>
                  )}
                <Button
                  variant="warning"
                  disabled={loading || authBusy || !initData}
                  onClick={() => void logoutGameAuth()}
                >
                  Закрыть игровой вход Wiki
                </Button>
              </div>
            </BaseCard>
          )}

        <div className="device-manager-heading">
          <CardTitle as="h3">Список устройств</CardTitle>
          <Button
            variant="secondary"
            size="sm"
            disabled={loading || !initData}
            onClick={() => void loadDevices(initData)}
          >
            Обновить
          </Button>
        </div>
        {devices.length ? (
          <div className="device-manager-list">
            {devices.map((device) => {
              const selectedRoute =
                routePolicy?.policy === "bridge_required" &&
                routePolicy.activeDeviceId === device.deviceId;
              return (
                <BaseCard
                  className="device-manager-device"
                  key={device.deviceId}
                >
                  <div className="device-manager-device-copy">
                    <CardTitle as="h4">{device.deviceName}</CardTitle>
                    <CardDescription>
                      {device.platform} · {statusLabel(device.status)}
                    </CardDescription>
                    {selectedRoute && (
                      <CardDescription>
                        {device.status === "active"
                          ? "Выбран для маршрута Wiki"
                          : "Маршрут Wiki выбран, но устройство отключено"}
                      </CardDescription>
                    )}
                  </div>
                  <div className="device-manager-device-actions">
                    {gameAccountBound === true &&
                      routePolicy &&
                      device.status === "active" &&
                      !selectedRoute && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={loading || !initData}
                          onClick={() => void selectDevice(device)}
                        >
                          {routePolicy.policy === "bridge_required"
                            ? "Переключить на этот компьютер"
                            : "Использовать для Wiki"}
                        </Button>
                      )}
                    {device.status === "active" && (
                      <Button
                        variant="warning"
                        size="sm"
                        disabled={loading}
                        onClick={() => void revoke(device)}
                      >
                        Отключить
                      </Button>
                    )}
                  </div>
                </BaseCard>
              );
            })}
          </div>
        ) : (
          <CardDescription>
            {loading
              ? "Загружаем устройства…"
              : "Подключённых компьютеров пока нет."}
          </CardDescription>
        )}
        {message && (
          <CardDescription as="p" role="status">
            {message}
          </CardDescription>
        )}
      </div>
    </Modal>
  );
}
