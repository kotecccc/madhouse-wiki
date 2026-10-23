import { useCardEditing, editableText } from "../CardEditing/CardEditing.jsx";
import "./Button.css";
import { Icon } from "../Icon/Icon.jsx";

const variants = new Set([
  "primary",
  "secondary",
  "locked",
  "card-action",
  "toggle",
  "nav-tab",
  "icon-copy",
  "icon-copy-inline",
]);

export function Button({
  type = "button",
  variant = "secondary",
  size = "md",
  className = "",
  children,
  icon,
  iconSize,
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
    safeVariant === "icon-copy-inline" && "button-icon-copy",
    `button-${safeVariant}`,
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
          <span className="button-label">{children}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}
