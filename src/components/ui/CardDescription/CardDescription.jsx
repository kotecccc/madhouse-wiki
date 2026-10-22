import { useCardEditing, editableText } from "../CardEditing/CardEditing.jsx";
import "./CardDescription.css";
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

export function CardDescription({
  as: Tag = "span",
  className = "",
  size,
  editKey,
  composition,
  children,
  ...props
}) {
  const editing = useCardEditing(
    editKey,
    "description",
    {
      size,
      ...editableText(children),
    },
    composition,
  );
  if (editing.overrides?.size) size = editing.values.size;
  const sizeClass = fontSizes.has(size) ? `card-description--${size}` : "";
  return (
    <Tag
      className={`card-description ${sizeClass} ${className} ${editing.className}`.trim()}
      {...props}
      {...editing.targetProps}
    >
      {editing.active && editing.values.text === ""
        ? "\u00a0"
        : (editing.values.content ?? editing.values.text ?? children)}
    </Tag>
  );
}
