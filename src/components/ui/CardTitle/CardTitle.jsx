import { useCardEditing, editableText } from "../CardEditing/CardEditing.jsx";
import "./CardTitle.css";
const fontSizes = new Set([
  "2xs",
  "xs",
  "sm",
  "md",
  "lg",
  "xl",
  "2xl",
  "3xl",
  "display",
]);

export function CardTitle({
  as: Tag = "strong",
  className = "",
  size,
  editKey,
  composition,
  children,
  ...props
}) {
  const editing = useCardEditing(
    editKey,
    "title",
    {
      size,
      ...editableText(children),
    },
    composition,
  );
  if (editing.overrides?.size) size = editing.values.size;
  const sizeClass = fontSizes.has(size) ? `card-title--${size}` : "";
  return (
    <Tag
      className={`card-title ${sizeClass} ${className} ${editing.className}`.trim()}
      {...props}
      {...editing.targetProps}
    >
      {editing.active && editing.values.text === ""
        ? "\u00a0"
        : (editing.values.content ?? editing.values.text ?? children)}
    </Tag>
  );
}
