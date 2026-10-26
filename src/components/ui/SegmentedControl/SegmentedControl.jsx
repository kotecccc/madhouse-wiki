import { useRef } from "react";
import { Pill } from "../Pill/Pill.jsx";
import { Button } from "../Button/Button.jsx";
import "./SegmentedControl.css";

export function nextSegmentedValue(options, currentValue, key) {
  const enabled = options.filter((option) => !option.disabled);
  if (!enabled.length) return currentValue;
  const foundIndex = enabled.findIndex(
    (option) => option.value === currentValue,
  );
  const index = Math.max(0, foundIndex);
  if (key === "Home") return enabled[0].value;
  if (key === "End") return enabled.at(-1).value;
  if (key !== "ArrowRight" && key !== "ArrowLeft") return currentValue;
  const direction = key === "ArrowRight" ? 1 : -1;
  return enabled[(index + direction + enabled.length) % enabled.length].value;
}

export function SegmentedControl({
  options,
  value,
  onChange,
  label,
  size = "md",
  className = "",
}) {
  const refs = useRef(new Map());
  const firstEnabledValue = options.find((option) => !option.disabled)?.value;
  const tabValue = options.some(
    (option) => option.value === value && !option.disabled,
  )
    ? value
    : firstEnabledValue;

  function select(option) {
    if (option.disabled) return;
    onChange(option.value);
  }

  function handleKeyDown(event) {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextValue = nextSegmentedValue(options, value, event.key);
    if (nextValue === value) return;
    select(options.find((option) => option.value === nextValue));
    refs.current.get(nextValue)?.focus();
  }

  return (
    <div
      className={`segmented-control ${className}`.trim()}
      role="radiogroup"
      aria-label={label}
      aria-busy={options.some((option) => option.loading) || undefined}
    >
      {options.map((option) => (
        <Button
          key={option.value}
          ref={(element) => {
            if (element) refs.current.set(option.value, element);
            else refs.current.delete(option.value);
          }}
          className={`segmented-control-option${option.loading ? " segmented-control-option--loading" : ""}`}
          variant="secondary"
          size={size}
          liftOnHover={false}
          role="radio"
          aria-checked={value === option.value}
          aria-label={option.ariaLabel}
          disabled={option.disabled}
          tabIndex={tabValue === option.value ? 0 : -1}
          onClick={() => select(option)}
          onKeyDown={handleKeyDown}
        >
          {option.label}
          {Number.isSafeInteger(option.count) && option.count > 0 && (
            <Pill size="2xs" dot={false} aria-hidden="true">
              {option.count}
            </Pill>
          )}
        </Button>
      ))}
    </div>
  );
}
