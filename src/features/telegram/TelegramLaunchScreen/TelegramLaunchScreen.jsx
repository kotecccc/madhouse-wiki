import { useEffect, useState } from "react";
import { LoadingStatus } from "../../../components/ui/LoadingStatus/LoadingStatus.jsx";
import "./TelegramLaunchScreen.css";

const APP_BACKGROUND = "#191816";

function getTelegramWebApp() {
  if (typeof window === "undefined") return null;
  const webApp = window.Telegram?.WebApp;
  if (!webApp) return null;

  const hasTelegramLaunch =
    (typeof webApp.initData === "string" && webApp.initData.length > 0) ||
    (typeof webApp.platform === "string" && webApp.platform !== "unknown");
  return hasTelegramLaunch ? webApp : null;
}

export function TelegramLaunchScreen() {
  const [webApp] = useState(getTelegramWebApp);
  const [visible, setVisible] = useState(Boolean(webApp));
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!webApp) return undefined;

    webApp.setHeaderColor?.(APP_BACKGROUND);
    webApp.setBackgroundColor?.(APP_BACKGROUND);
    webApp.expand?.();
    webApp.ready?.();

    const leaveTimer = window.setTimeout(() => setLeaving(true), 180);
    const hideTimer = window.setTimeout(() => setVisible(false), 470);
    return () => {
      window.clearTimeout(leaveTimer);
      window.clearTimeout(hideTimer);
    };
  }, [webApp]);

  if (!visible) return null;

  return (
    <div
      className={
        "telegram-launch-screen" +
        (leaving ? " telegram-launch-screen--leaving" : "")
      }
    >
      <div className="telegram-launch-screen-content">
        <span className="telegram-launch-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <strong className="telegram-launch-title">
          MADHOUSE <b>WIKI</b>
        </strong>
        <LoadingStatus>Загружаем справочник</LoadingStatus>
      </div>
    </div>
  );
}
