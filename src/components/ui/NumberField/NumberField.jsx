import { FieldLabel } from "../FieldLabel/FieldLabel.jsx";
import "./NumberField.css";
export function NumberField({ id, label, hint, suffix, ...props }) {
  return (
    <>
      <FieldLabel htmlFor={id} hint={hint}>
        {label}
      </FieldLabel>
      <div className="input-wrap">
        <input
          id={id}
          type="number"
          min="0"
          step="1"
          inputMode="numeric"
          {...props}
        />
        <span className="input-suffix">{suffix}</span>
      </div>
    </>
  );
}
