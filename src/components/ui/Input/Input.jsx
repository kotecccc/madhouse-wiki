import "./Input.css";

export function Input({ size = "md", className = "", ...props }) {
  const safeSize = ["sm", "md", "lg"].includes(size) ? size : "md";
  return (
    <input
      className={`input-control input-control--${safeSize} ${className}`.trim()}
      {...props}
    />
  );
}
