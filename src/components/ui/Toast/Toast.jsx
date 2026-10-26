import { BaseCard } from "../BaseCard/BaseCard.jsx";
import { Button } from "../Button/Button.jsx";
import "./Toast.css";

export function Toast({ children, onDismiss }) {
  return (
    <div
      className="ui-toast-region"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <BaseCard className="ui-toast" variant="warning">
        <span>{children}</span>
        <Button
          variant="icon-ghost"
          size="sm"
          icon="close"
          iconOnly
          aria-label="Закрыть уведомление"
          onClick={onDismiss}
        />
      </BaseCard>
    </div>
  );
}
