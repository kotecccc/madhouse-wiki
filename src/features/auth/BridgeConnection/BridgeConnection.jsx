import { useEffect, useId, useRef, useState } from "react";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { FieldLabel } from "../../../components/ui/FieldLabel/FieldLabel.jsx";
import { Input } from "../../../components/ui/Input/Input.jsx";
import "./BridgeConnection.css";

const errors = {
  invalid_game_token: "Игровой токен недействителен. Введите новый.",
  device_unavailable: "Сначала подключите устройство и запустите мост.",
  device_offline:
    "Мост устройства не подключён. Откройте iSH или Терминал и запустите его.",
  wiki_unreachable:
    "Нет связи с Wiki. Проверьте интернет и повторите проверку состояния.",
  bridge_unavailable:
    "Не удалось проверить соединение с игрой через мост. Проверьте устройство и повторите попытку.",
  device_changed: "Устройство отключилось. Повторите проверку.",
  account_mismatch: "Этот токен относится к другому игровому аккаунту.",
  account_already_bound: "Игровой аккаунт уже привязан к другому пользователю.",
  profile_unavailable: "Игра не смогла вернуть профиль. Попробуйте позже.",
  profile_invalid: "Игра вернула непонятный ответ. Попробуйте позже.",
  direct_requests_in_flight:
    "Есть незавершённый запрос к игре. Подключение станет доступно после его проверки.",
  not_authorized:
    "Закройте мини-приложение и откройте Wiki из Telegram заново.",
  rate_limited: "Слишком много попыток. Попробуйте позже.",
};

/** Mount only after the server and signed installation are ready. */
export function BridgeConnection({ client, createInstallCommand, onBound }) {
  const inputId = useId();
  const [device, setDevice] = useState(null);
  const [status, setStatus] = useState(null);
  const [token, setToken] = useState("");
  const [command, setCommand] = useState("");
  const [invitation, setInvitation] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [expiresAt, setExpiresAt] = useState(0);
  const busyRef = useRef(false);
  const statusRequestRef = useRef(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    function load() {
      const current = ++statusRequestRef.current;
      Promise.all([
        client.list(controller.signal),
        client.status(controller.signal),
      ])
        .then(([nextDevice, nextStatus]) => {
          if (
            !controller.signal.aborted &&
            current === statusRequestRef.current
          ) {
            setDevice(nextDevice);
            setStatus(nextStatus);
            setLoaded(true);
            setError("");
          }
        })
        .catch((reason) => {
          if (
            !controller.signal.aborted &&
            current === statusRequestRef.current
          ) {
            setStatus(null);
            setError(
              errors[reason?.code] || "Не удалось получить состояние моста.",
            );
          }
        });
    }
    function onVisibilityChange() {
      if (document.visibilityState === "visible") load();
    }
    load();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      controller.abort();
      statusRequestRef.current += 1;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [client]);

  useEffect(() => {
    if (!expiresAt) return undefined;
    const timer = setTimeout(
      () => {
        setCommand("");
        setInvitation("");
        setExpiresAt(0);
      },
      Math.max(0, expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);

  async function perform(action) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (reason) {
      if (reason?.code === "device_offline")
        setStatus((current) => current && { ...current, device: "offline" });
      setError(
        errors[reason?.code] ||
          "Не удалось выполнить действие. Повторите попытку.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function refresh() {
    const current = ++statusRequestRef.current;
    let nextDevice, nextStatus;
    try {
      [nextDevice, nextStatus] = await Promise.all([
        client.list(),
        client.status(),
      ]);
    } catch (reason) {
      if (current === statusRequestRef.current) setStatus(null);
      throw reason;
    }
    if (current !== statusRequestRef.current) return;
    setDevice(nextDevice);
    setStatus(nextStatus);
    setLoaded(true);
    if (nextDevice) {
      setCommand("");
      setInvitation("");
      setExpiresAt(0);
    }
  }
  return (
    <BaseCard className="bridge-connection">
      <CardTitle>Мост устройства</CardTitle>
      <CardDescription>
        Запустите мост на iPhone или Mac, чтобы подключать игру через это
        устройство.
      </CardDescription>
      <div className="bridge-connection-status" aria-live="polite">
        <CardDescription>
          Устройство:{" "}
          {status
            ? status.device === "online"
              ? "подключено"
              : "не подключено"
            : "не проверено"}
        </CardDescription>
        <CardDescription>
          Игровой токен:{" "}
          {status
            ? status.account === "saved"
              ? "сохранён"
              : "не добавлен"
            : "не проверен"}
        </CardDescription>
      </div>
      {loaded && !device && typeof createInstallCommand === "function" && (
        <Button
          disabled={busy}
          onClick={() =>
            perform(async () => {
              const invite = await client.invite();
              const nextCommand = createInstallCommand(invite);
              if (typeof nextCommand !== "string" || !nextCommand)
                throw new Error("installation_unavailable");
              if (invite.expiresAt <= Date.now())
                throw new Error("invitation_expired");
              setCommand(nextCommand);
              setInvitation(invite.invitation);
              setExpiresAt(invite.expiresAt);
            })
          }
        >
          Подключить устройство
        </Button>
      )}
      {command && (
        <>
          <CardDescription>
            На Mac скачайте архив, распакуйте и откройте файл моста. При первом
            запуске нажмите правой кнопкой и выберите «Открыть», затем вставьте
            одноразовый ключ ниже. Позже запускайте тот же файл двойным
            нажатием.
          </CardDescription>
          <Button
            onClick={() => {
              const url = new URL(
                "/bridge/MadhouseWikiBridge-macOS.zip",
                window.location.origin,
              ).href;
              if (window.Telegram?.WebApp?.openLink)
                window.Telegram.WebApp.openLink(url);
              else window.location.assign(url);
            }}
          >
            Скачать мост для Mac
          </Button>
          <FieldLabel htmlFor={`${inputId}-invitation`}>
            Одноразовый ключ
          </FieldLabel>
          <Input id={`${inputId}-invitation`} value={invitation} readOnly />
          <Button
            disabled={busy}
            onClick={() =>
              perform(async () => {
                await navigator.clipboard.writeText(invitation);
                setMessage("Ключ скопирован.");
              })
            }
          >
            Скопировать ключ
          </Button>
          <FieldLabel htmlFor={`${inputId}-command`}>
            Команда для iPhone
          </FieldLabel>
          <Input id={`${inputId}-command`} value={command} readOnly />
          <Button
            disabled={busy}
            onClick={() =>
              perform(async () => {
                await navigator.clipboard.writeText(command);
                setMessage("Команда скопирована.");
              })
            }
          >
            Скопировать команду
          </Button>
          <CardDescription>
            Вставьте команду в iSH на iPhone или в Терминал на Mac. На iPhone
            разрешите геолокацию для работы при переключении приложений;
            координаты не сохраняются.
          </CardDescription>
        </>
      )}
      {device && (
        <>
          {status?.device === "offline" && (
            <CardDescription>
              Если мост остановился, откройте iSH или Терминал и выполните:
              python3 ~/.madhouse-bridge/bootstrap.pyz
            </CardDescription>
          )}
          {status?.account === "saved" && (
            <Button
              disabled={busy || status.device !== "online"}
              onClick={() =>
                perform(async () => {
                  await client.profile();
                  setMessage("Игровой профиль доступен через мост.");
                })
              }
            >
              Проверить игру
            </Button>
          )}
          <FieldLabel htmlFor={`${inputId}-token`}>
            Игровой accessToken
          </FieldLabel>
          <Input
            id={`${inputId}-token`}
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <div className="bridge-connection-actions">
            <Button
              variant="primary"
              disabled={busy || !token || status?.device !== "online"}
              onClick={() =>
                perform(async () => {
                  await client.bind(token.trim());
                  await onBound?.(token.trim());
                  setToken("");
                  setMessage("Игровой аккаунт подтверждён.");
                  await refresh();
                })
              }
            >
              Подключить игру
            </Button>
            <Button
              variant="warning"
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  await client.revoke(device.deviceId);
                  setCommand("");
                  setToken("");
                  await refresh();
                })
              }
            >
              Отключить устройство
            </Button>
          </div>
        </>
      )}
      <Button disabled={busy} onClick={() => perform(refresh)}>
        Обновить состояние
      </Button>
      {error && <CardDescription role="alert">{error}</CardDescription>}
      {message && <CardDescription role="status">{message}</CardDescription>}
    </BaseCard>
  );
}
