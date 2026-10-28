import { useCardEditing, editableText } from "../CardEditing/CardEditing.jsx";
import "./Button.css";
import { Icon } from "../Icon/Icon.jsx";

const variants = new Set([
  "text-tag",
  "primary",
  "secondary",
  "locked",
  "warning",
  "card-action",
  "menu-item",
  "toggle",
  "nav-tab",
  "icon-copy",
  "icon-copy-inline",
  "icon-ghost",
  "warning-icon",
]);

export function Button({
  type = "button",
  variant = "secondary",
  accent,
  tone,
  size = "md",
  className = "",
  children,
  icon,
  iconSize,
  menuValue,
  iconOnly = false,
  editKey,
  liftOnHover = true,
  ...props
}) {
  const editing = useCardEditing(editKey, "button", {
    size,
    variant,
    ...editableText(children),
  });
  if (editing.active) {
    size = editing.values.size;
    variant = editing.values.variant;
    children = editing.values.text ?? children;
  }
  const safeVariant = variants.has(variant) ? variant : "secondary";
  const safeSize = ["sm", "md", "lg"].includes(size) ? size : "md";
  const classes = [
    "button",
    iconOnly && "button--icon-only",
    safeVariant === "icon-copy-inline" && "button-icon-copy",
    safeVariant === "icon-ghost" && "button-icon-ghost",
    safeVariant === "warning-icon" && "button-warning-icon",
    (safeVariant === "warning" ||
      (safeVariant === "menu-item" && tone === "warning")) &&
      "button-warning",
    `button-${safeVariant}`,
    accent === "gold" && "button--accent-gold",
    tone === "inherit" && "button--inherit-color",
    `button-size-${safeSize}`,
    !liftOnHover && "button--no-lift",
    className,
    editing.className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type={type}
      className={classes}
      {...props}
      {...editing.targetProps}
      disabled={editing.active ? false : props.disabled}
    >
      {icon ? (
        <>
          <Icon type={icon} size={iconSize} />
          {!iconOnly && <span className="button-label">{children}</span>}
        </>
      ) : (
        children
      )}
      {safeVariant === "menu-item" && menuValue != null && (
        <span className="button-menu-item-value">{menuValue}</span>
      )}
    </button>
  );
}
