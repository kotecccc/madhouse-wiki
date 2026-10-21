import "./FieldLabel.css";
import "./FieldLabel.css";

export function FieldLabel({ htmlFor, hint, children, className = "" }) {
  return (
    <label className={`field-label ${className}`.trim()} htmlFor={htmlFor}>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
