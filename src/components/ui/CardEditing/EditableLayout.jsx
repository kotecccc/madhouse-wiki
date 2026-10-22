import { useCardEditing } from "./CardEditing.jsx";

// Layout-only editing, retaining the feature's original surface and semantics.
export function EditableLayout({
  as: Tag = "div",
  editKey,
  className = "",
  paddingDefault = "12",
  gapDefault = "8",
  children,
  stack = false,
  style,
  ...props
}) {
  const editing = useCardEditing(editKey, "card", {
    padding: paddingDefault,
    gap: gapDefault,
  });
  return (
    <Tag
      {...props}
      {...editing.targetProps}
      className={`${className} ${editing.className}`.trim()}
      style={{
        ...style,
        ...(stack && editing.overrides?.gap
          ? { display: "grid", gridTemplateColumns: "minmax(0, 1fr)" }
          : {}),
        ...(editing.overrides?.padding
          ? { padding: `var(--space-${editing.values.padding})` }
          : {}),
        ...(editing.overrides?.gap
          ? { gap: `var(--space-${editing.values.gap})` }
          : {}),
      }}
    >
      {children}
    </Tag>
  );
}
