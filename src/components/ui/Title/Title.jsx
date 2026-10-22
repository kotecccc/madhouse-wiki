import { useCardEditing, editableText } from "../CardEditing/CardEditing.jsx";
import "./Title.css";

export function Title({
  as: Tag = "h2",
  level,
  className = "",
  editKey,
  children,
  ...props
}) {
  const editing = useCardEditing(editKey, "heading", {
    level: level || Tag,
    ...editableText(children),
  });
  const headingLevel = editing.values.level;
  return (
    <Tag
      className={`title title--${headingLevel}${className ? ` ${className}` : ""} ${editing.className}`}
      {...props}
      {...editing.targetProps}
    >
      {editing.values.text ?? children}
    </Tag>
  );
}
