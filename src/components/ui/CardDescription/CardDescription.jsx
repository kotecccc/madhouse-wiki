import "./CardDescription.css";
export function CardDescription({
  as: Tag = "span",
  className = "",
  ...props
}) {
  return <Tag className={`card-description ${className}`.trim()} {...props} />;
}
