import "./Button.css";
import { Icon } from "../Icon/Icon.jsx";
export function Button({
  type = "button",
  variant,
  className = "",
  children,
  icon,
  ...props
}) {
  const classes = [
    variant && "button",
    variant && `button-${variant}`,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type} className={classes || undefined} {...props}>
      {icon ? (
        <>
          <Icon type={icon} />
          <span className="button-label">{children}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}
