import { Button } from "../Button/Button.jsx";
import { Icon } from "../Icon/Icon.jsx";

export function MenuItem({
  warning = false,
  informational = false,
  interactive = false,
  icon,
  leading,
  image,
  value,
  children,
  ...props
}) {
  if (informational) {
    const Tag = interactive ? "button" : "div";
    return (
      <Tag
        className={`button button-menu-item button-menu-item--informational button-size-md button--no-lift${interactive ? " button-menu-item--interactive" : ""}`}
        {...(interactive ? { type: "button" } : {})}
        {...props}
      >
        {image ? (
          <span className="button-menu-item-image-slot">
            <img className="button-menu-item-image" src={image} alt="" />
          </span>
        ) : (
          leading || (icon && <Icon type={icon} />)
        )}
        <span className="button-label">{children}</span>
        {value != null && (
          <span className="button-menu-item-value">{value}</span>
        )}
      </Tag>
    );
  }
  return (
    <Button
      {...props}
      icon={icon}
      menuValue={value}
      variant="menu-item"
      tone={warning ? "warning" : undefined}
      liftOnHover={false}
    >
      {children}
    </Button>
  );
}
