import { Button } from "../Button/Button.jsx";
import { FieldLabel } from "../FieldLabel/FieldLabel.jsx";
import { Input } from "../Input/Input.jsx";
import "./NumberStepper.css";

export function NumberStepper({ id, label, value, min = 1, max, onChange }) {
  const update = (nextValue) => {
    const parsed = Number(nextValue);
    if (Number.isSafeInteger(parsed)) onChange(Math.min(max, Math.max(min, parsed)));
  };
  return (
    <div className="number-stepper">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="number-stepper-controls">
        <Button variant="secondary" disabled={value <= min} onClick={() => update(value - 1)} aria-label="Уменьшить уровень">−</Button>
        <Input id={id} type="number" inputMode="numeric" min={min} max={max} step="1" value={value} onChange={(event) => update(event.target.value)} />
        <Button variant="secondary" disabled={value >= max} onClick={() => update(value + 1)} aria-label="Увеличить уровень">+</Button>
      </div>
      <span className="number-stepper-range">От {min} до {max}</span>
    </div>
  );
}
