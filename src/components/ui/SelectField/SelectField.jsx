import "./SelectField.css";
import { FieldLabel } from "../FieldLabel/FieldLabel.jsx";
import { Icon } from "../Icon/Icon.jsx";
export function SelectField({
  id,
  label,
  options,
  icon,
  className = "",
  spacing = "normal",
  size = "md",
  ...props
}) {
  const safeSize = ["sm", "md", "lg"].includes(size) ? size : "md";
  return (
    <div
      className={`select-field-group${spacing === "none" ? " select-field-group--none" : ""}`}
    >
      {label ? <FieldLabel htmlFor={id}>{label}</FieldLabel> : null}
      <div className="select-field-wrap">
        {icon && (
          <Icon
            type={icon}
            size="small"
            className="select-field-leading-icon"
          />
        )}
        <select
          className={`select-field select-field--${safeSize} ${icon ? "select-field--with-icon" : ""} ${className}`.trim()}
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
        <Icon type="chevron" size="small" className="select-field-icon" />
      </div>
    </div>
  );
}
