import "./CardTitle.css";
export function CardTitle({ as: Tag = "strong", className = "", ...props }) {
  return <Tag className={`card-title ${className}`.trim()} {...props} />;
}
