import "./BaseCard.css";
export function BaseCard({
  as: Tag = "div",
  className = "",
  variant,
  children,
  ...props
}) {
  return (
    <Tag
      className={["base-card", variant && `base-card--${variant}`, className]
        .filter(Boolean)
        .join(" ")}
      {...props}
    >
      {children}
    </Tag>
  );
}
