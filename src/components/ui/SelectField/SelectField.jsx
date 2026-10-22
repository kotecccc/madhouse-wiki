import "./SelectField.css";
import { FieldLabel } from "../FieldLabel/FieldLabel.jsx";
export function SelectField({
  id,
  label,
  options,
  className = "",
  spacing = "normal",
  size = "md",
  ...props
}) {
  const safeSize = ["sm", "md", "lg"].includes(size) ? size : "md";
  return (
    <>
      {label ? <FieldLabel htmlFor={id}>{label}</FieldLabel> : null}
      <select
        className={`select-field select-field--${safeSize}${spacing === "none" ? " select-field--none" : ""} ${className}`.trim()}
        id={id}
        {...props}
      >
        {options.map((option) => (
          <option
            key={option.id}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </option>
        ))}
      </select>
    </>
  );
}
