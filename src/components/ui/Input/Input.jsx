import { Icon } from "../Icon/Icon.jsx";
import "./Input.css";

export function Input({
  size = "md",
  className = "",
  icon,
  surface,
  ...props
}) {
  const safeSize = ["sm", "md", "lg"].includes(size) ? size : "md";
  const input = (
    <input
      className={`input-control input-control--${safeSize} ${icon ? "input-control--with-icon" : ""} ${surface === "card" ? "input-control--card" : ""} ${className}`.trim()}
      {...props}
    />
  );
  return icon ? (
    <span className="input-icon-wrap">
      <Icon type={icon} size="small" className="input-leading-icon" />
      {input}
    </span>
  ) : (
    input
  );
}
