import { useCardEditing, editableText } from "../CardEditing/CardEditing.jsx";
import "./Pill.css";

export function Pill({
  variant = "scheduled",
  size = "sm",
  dot = true,
  compact = false,
  motion,
  editKey,
  className = "",
  children,
  ...props
}) {
  const editing = useCardEditing(editKey, "pill", {
    variant,
    size,
    dot,
    ...editableText(children),
  });
  if (editing.active) {
    variant = editing.values.variant;
    size = editing.overrides.size ?? size;
    dot = editing.values.dot;
    children = editing.values.text ?? children;
  }
  return (
    <span
      className={`ui-pill ui-pill--${variant} ui-pill--${size} ${compact ? "ui-pill--compact" : ""} ${className} ${editing.className}`.trim()}
      {...props}
      {...editing.targetProps}
    >
      {(compact || dot) && <span className="ui-pill-dot" aria-hidden="true" />}
      {!compact &&
        (motion === "pulse" ? (
          <span className="ui-pill-text--pulse">{children}</span>
        ) : (
          children
        ))}
    </span>
  );
}
