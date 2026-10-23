import "./LockIndicator.css";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";

export function LockIndicator({
  label = "Заблокировано в игре",
  className = "",
  locked = true,
  variant,
  size = "small",
}) {
  const variantClass = variant === "locked" ? "lock-indicator--locked" : "";
  return (
    <span
      className={`lock-indicator ${variantClass} ${className}`.trim()}
      role="img"
      aria-label={label}
      title={label}
    >
      <Icon type={locked ? "lock" : "unlock"} size={size} />
    </span>
  );
}
