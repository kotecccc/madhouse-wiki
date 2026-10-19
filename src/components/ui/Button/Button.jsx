import "./Button.css";
export function Button({
  type = "button",
  variant,
  className = "",
  children,
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
      {children}
    </button>
  );
}
