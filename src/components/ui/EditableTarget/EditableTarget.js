import "./EditableTarget.css";

// Applied to the actual editable element, without a wrapper that changes layout.
export function editableTargetProps(enabled, className = "") {
  return {
    className: [className, enabled && "ui-editable-target"]
      .filter(Boolean)
      .join(" "),
  };
}
