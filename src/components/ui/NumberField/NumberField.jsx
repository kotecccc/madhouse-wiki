import { FieldLabel } from "../FieldLabel/FieldLabel.jsx";
import { Input } from "../Input/Input.jsx";
import "./NumberField.css";
export function NumberField({
  id,
  label,
  hint,
  suffix,
  suffixClassName = "",
  spacing = "normal",
  size = "md",
  ...props
}) {
  return (
    <>
      <FieldLabel htmlFor={id} hint={hint}>
        {label}
      </FieldLabel>
      <div
        className={`input-wrap${spacing === "none" ? " input-wrap--none" : ""}`}
      >
        <Input
          id={id}
          type="number"
          min="0"
          step="1"
          inputMode="numeric"
          className="input-control--with-suffix"
          size={size}
          {...props}
        />
        <span className={`input-suffix ${suffixClassName}`}>{suffix}</span>
      </div>
    </>
  );
}
