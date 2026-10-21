import "./Input.css";

export function Input({ className = "", ...props }) {
  return <input className={`input-control ${className}`.trim()} {...props} />;
}
