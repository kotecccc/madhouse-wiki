import "./SelectField.css";
import { FieldLabel } from "../FieldLabel/FieldLabel.jsx";
export function SelectField({ id, label, options, className = "", ...props }) {
  return (
    <>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <select className={`select-field ${className}`.trim()} id={id} {...props}>
        {options.map((option) => (
          <option key={option.id} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </>
  );
}
