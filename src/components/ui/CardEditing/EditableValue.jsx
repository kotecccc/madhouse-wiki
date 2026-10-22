import { editableText, useCardEditing } from "./CardEditing.jsx";

// Retains the existing semantic element and appearance for domain-specific values.
export function EditableValue({
  as: Tag = "span",
  editKey,
  className = "",
  children,
  ...props
}) {
  const editing = useCardEditing(editKey, "text", editableText(children));
  return (
    <Tag
      {...props}
      {...editing.targetProps}
      className={`${className} ${editing.className}`.trim()}
    >
      {editing.values.text ?? children}
    </Tag>
  );
}
