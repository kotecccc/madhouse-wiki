import { Button } from "../Button/Button.jsx";
import { FieldLabel } from "../FieldLabel/FieldLabel.jsx";
import { Input } from "../Input/Input.jsx";
import "./NumberStepper.css";

export function NumberStepper({
  id,
  label,
  hideLabel = false,
  compact = false,
  showMaxButton = false,
  maxToggle,
  disabled = false,
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
      <div
        className={`number-stepper-controls${showMaxButton || maxToggle ? " number-stepper-controls--max" : ""}`}
      >
        <div className="number-stepper-manual">
          <Button
            size="md"
            variant="secondary"
            liftOnHover={false}
            disabled={disabled || maxToggle?.active || value <= min}
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
            disabled={disabled || maxToggle?.active}
            onChange={(event) => update(event.target.value)}
          />
          <Button
            size="md"
            variant="secondary"
            liftOnHover={false}
            disabled={disabled || maxToggle?.active || value >= max}
            onClick={() => update(value + 1)}
            aria-label={incrementLabel}
          >
            +
          </Button>
        </div>
        {maxToggle ? (
          <Button
            size="md"
            variant="toggle"
            liftOnHover={false}
            disabled={maxToggle.disabled}
            aria-pressed={maxToggle.active}
            onClick={maxToggle.onToggle}
          >
            {maxToggle.label ?? "MAX"}
          </Button>
        ) : showMaxButton ? (
          <Button
            size="md"
            variant="secondary"
            liftOnHover={false}
            disabled={!Number.isSafeInteger(max) || value >= max}
            onClick={() => update(max)}
            aria-label="Установить максимальное количество"
          >
            MAX
          </Button>
        ) : null}
      </div>
      <span className="number-stepper-range">
        {rangeLabel || `От ${min} до ${max}`}
      </span>
    </div>
  );
}
