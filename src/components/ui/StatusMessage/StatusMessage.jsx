import { Icon } from "../Icon/Icon.jsx";
import { Title } from "../Title/Title.jsx";
import "./StatusMessage.css";

export function StatusMessage({
  icon = "warning",
  title,
  description,
  tone = "default",
  compact = false,
  iconAlignment = "start",
  children,
}) {
  const classes = [
    "status-message",
    `status-message--${tone}`,
    compact && "status-message--compact",
    compact && iconAlignment === "center" && "status-message--icon-center",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section className={classes}>
      <span className="status-message__icon">
        <Icon type={icon} size={compact ? "large" : "hero"} />
      </span>
      <div className="status-message__content">
        {title && <Title as={compact ? "h4" : "h3"}>{title}</Title>}
        {description && (
          <p className="status-message__description">{description}</p>
        )}
        {children}
      </div>
    </section>
  );
}
