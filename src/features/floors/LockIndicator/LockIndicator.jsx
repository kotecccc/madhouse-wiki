import "./LockIndicator.css";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";

export function LockIndicator({
  label = "Заблокировано в игре",
  className = "",
  size = 12,
  locked = true,
}) {
  return (
    <span
      className={`lock-indicator ${className}`.trim()}
      style={{ "--lock-indicator-size": typeof size === "number" ? `${size}px` : size }}
      role="img"
      aria-label={label}
      title={label}
    >
      <Icon type={locked ? "lock" : "unlock"} />
    </span>
  );
}
