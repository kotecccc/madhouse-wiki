import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../Icon/Icon.jsx";
import { ToastTargetContext } from "./ToastContext.jsx";
import { BaseCard } from "../BaseCard/BaseCard.jsx";
import { Button } from "../Button/Button.jsx";
import "./Toast.css";

export function Toast({
  children,
  onDismiss,
  floating = false,
  urgent = false,
  success = false,
  action,
  title,
  icon,
}) {
  const target = useContext(ToastTargetContext);
  const dismissRef = useRef(onDismiss);
  const [closing, setClosing] = useState(false);
  const close = useCallback(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      dismissRef.current?.();
      return;
    }
    setClosing(true);
  }, []);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);
  useEffect(() => {
    if (!success || urgent) return;
    const timer = setTimeout(close, 2000);
    return () => clearTimeout(timer);
  }, [success, urgent, children, title, close]);
  const tone = urgent ? "error" : success ? "success" : "warning";
  const content = (
    <div
      className={`ui-toast-region${floating ? (target ? " ui-toast-region--anchored" : " ui-toast-region--floating") : ""}`}
      role={urgent ? "alert" : "status"}
      aria-live={urgent ? "assertive" : "polite"}
      aria-atomic="true"
    >
      <BaseCard
        className={`ui-toast ui-toast--${tone}${closing ? " ui-toast--closing" : ""}`}
        onAnimationEnd={(event) => {
          if (
            closing &&
            event.target === event.currentTarget &&
            event.animationName === "ui-toast-exit"
          )
            dismissRef.current?.();
        }}
        variant={tone === "warning" ? "warning" : `toast-${tone}`}
        padding="12"
      >
        <span className="ui-toast-icon">
          <Icon
            type={icon || (success ? "check" : "warning")}
            size="large"
            tone="inherit"
          />
        </span>
        <div className="ui-toast-content">
          <strong className="ui-toast-title">
            {title || (urgent ? "Ошибка" : "Внимание")}
          </strong>
          {children && <div className="ui-toast-message">{children}</div>}
          {action && <div className="ui-toast-action">{action}</div>}
        </div>
        <Button
          variant="icon-ghost"
          tone="inherit"
          size="sm"
          icon="close"
          iconOnly
          aria-label="Закрыть уведомление"
          onClick={close}
        />
      </BaseCard>
    </div>
  );
  return floating && target ? createPortal(content, target) : content;
}
