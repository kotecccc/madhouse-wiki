import { useCardEditing } from "../CardEditing/CardEditing.jsx";
import "./BaseCard.css";
const paddingSizes = new Set([
  "4",
  "8",
  "12",
  "16",
  "24",
  "32",
  "40",
  "48",
  "64",
]);
const inlinePaddingSizes = new Set(["4", "8", "12", "16", "24", "32"]);

export function BaseCard({
  as: Tag = "div",
  className = "",
  variant,
  state,
  padding,
  paddingInline,
  editKey,
  children,
  ...props
}) {
  const editing = useCardEditing(editKey, "card", {
    padding: String(padding || (variant === "floor-data" ? "12" : "16")),
    gap: "8",
  });
  if (editing.overrides?.padding) padding = editing.values.padding;
  const paddingClass = paddingSizes.has(String(padding))
    ? `base-card--padding-${padding}`
    : "";
  const inlinePaddingClass = inlinePaddingSizes.has(String(paddingInline))
    ? `base-card--padding-inline-${paddingInline}`
    : "";
  return (
    <Tag
      className={[
        "base-card",
        variant && `base-card--${variant}`,
        state === "locked" && "base-card--locked",
        state === "target" && "base-card--target",
        state === "warning" && "base-card--warning",
        paddingClass,
        inlinePaddingClass,
        editing.className,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
      {...editing.targetProps}
      style={{
        ...props.style,
        ...(editing.overrides?.gap
          ? { gap: `var(--space-${editing.values.gap})` }
          : {}),
      }}
    >
      {children}
    </Tag>
  );
}
