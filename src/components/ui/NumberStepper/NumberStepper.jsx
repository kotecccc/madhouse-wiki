import { Button } from "../Button/Button.jsx";
import { FieldLabel } from "../FieldLabel/FieldLabel.jsx";
import { Input } from "../Input/Input.jsx";
import "./NumberStepper.css";

export function NumberStepper({
  id,
  label,
  hideLabel = false,
  compact = false,
  value,
  min = 1,
  max,
  onChange,
  decrementLabel = "Уменьшить уровень",
  incrementLabel = "Увеличить уровень",
  rangeLabel,
}) {
  const update = (nextValue) => {
    const parsed = Number(nextValue);
    if (Number.isSafeInteger(parsed))
      onChange(Math.min(max, Math.max(min, parsed)));
  };
  return (
    <div
      className={`number-stepper${compact ? " number-stepper--compact" : ""}`}
    >
      {!hideLabel && <FieldLabel htmlFor={id}>{label}</FieldLabel>}
      <div className="number-stepper-controls">
        <Button
          size="md"
          variant="secondary"
          liftOnHover={false}
          disabled={value <= min}
          onClick={() => update(value - 1)}
          aria-label={decrementLabel}
        >
          −
        </Button>
        <Input
          className="input-control--center"
          id={id}
          aria-label={hideLabel ? label : undefined}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step="1"
          value={value}
          onChange={(event) => update(event.target.value)}
        />
        <Button
          size="md"
          variant="secondary"
          liftOnHover={false}
          disabled={value >= max}
          onClick={() => update(value + 1)}
          aria-label={incrementLabel}
        >
          +
        </Button>
      </div>
      <span className="number-stepper-range">
        {rangeLabel || `От ${min} до ${max}`}
      </span>
    </div>
  );
}
