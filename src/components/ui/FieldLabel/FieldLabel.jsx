import "./FieldLabel.css";
import "./FieldLabel.css";

export function FieldLabel({ htmlFor, hint, children }) {
  return (
    <label className="field-label" htmlFor={htmlFor}>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
