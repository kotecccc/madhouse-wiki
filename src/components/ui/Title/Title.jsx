import "./Title.css";

export function Title({ as: Tag = "h2", level, className = "", ...props }) {
  const headingLevel = level || Tag;
  return (
    <Tag
      className={`title title--${headingLevel}${className ? ` ${className}` : ""}`}
      {...props}
    />
  );
}
