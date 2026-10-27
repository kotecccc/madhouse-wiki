import { useContext } from "react";
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
  action,
}) {
  const target = useContext(ToastTargetContext);
  const content = (
    <div
      className={`ui-toast-region${floating ? (target ? " ui-toast-region--anchored" : " ui-toast-region--floating") : ""}`}
      role={urgent ? "alert" : "status"}
      aria-live={urgent ? "assertive" : "polite"}
      aria-atomic="true"
    >
      <BaseCard
        className={`ui-toast ui-toast--${urgent ? "error" : "warning"}`}
        variant={urgent ? "toast-error" : "warning"}
        padding="12"
      >
        <span className="ui-toast-icon">
          <Icon type="warning" size="large" tone="inherit" />
        </span>
        <div className="ui-toast-content">
          <strong className="ui-toast-title">
            {urgent ? "Ошибка" : "Внимание"}
          </strong>
          <div className="ui-toast-message">{children}</div>
          {action && <div className="ui-toast-action">{action}</div>}
        </div>
        <Button
          variant="icon-ghost"
          tone="inherit"
          size="sm"
          icon="close"
          iconOnly
          aria-label="Закрыть уведомление"
          onClick={onDismiss}
        />
      </BaseCard>
    </div>
  );
  return floating && target ? createPortal(content, target) : content;
}
