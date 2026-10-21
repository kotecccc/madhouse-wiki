import { FieldLabel } from "../FieldLabel/FieldLabel.jsx";
import { Input } from "../Input/Input.jsx";
import "./NumberField.css";
export function NumberField({
  id,
  label,
  hint,
  suffix,
  suffixClassName = "",
  ...props
}) {
  return (
    <>
      <FieldLabel htmlFor={id} hint={hint}>
        {label}
      </FieldLabel>
      <div className="input-wrap">
        <Input
          id={id}
          type="number"
          min="0"
          step="1"
          inputMode="numeric"
          {...props}
        />
        <span className={`input-suffix ${suffixClassName}`}>{suffix}</span>
      </div>
    </>
  );
}
