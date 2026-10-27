import { Button } from "../Button/Button.jsx";
import { Icon } from "../Icon/Icon.jsx";

export function MenuItem({
  warning = false,
  informational = false,
  icon,
  children,
  ...props
}) {
  if (informational) {
    return (
      <div
        className="button button-menu-item button-menu-item--informational button-size-md button--no-lift"
        {...props}
      >
        {icon && <Icon type={icon} />}
        <span className="button-label">{children}</span>
      </div>
    );
  }
  return (
    <Button
      {...props}
      icon={icon}
      variant="menu-item"
      tone={warning ? "warning" : undefined}
      liftOnHover={false}
    >
      {children}
    </Button>
  );
}
