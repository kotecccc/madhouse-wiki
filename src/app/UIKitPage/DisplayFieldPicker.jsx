import { useState } from "react";
import { Button } from "../../components/ui/Button/Button.jsx";
import { CardDescription } from "../../components/ui/CardDescription/CardDescription.jsx";
import { normalizeFieldSelection } from "../../lib/card-display-fields.js";
import "./DisplayFieldPicker.css";

export function DisplayFieldPicker({
  fields,
  selected,
  onChange,
  breakBefore = [],
  onBreakChange,
}) {
  const [adding, setAdding] = useState(false);
  const ids =
    normalizeFieldSelection(
      selected,
      fields.map((field) => field.id),
    ) || [];
  const remaining = fields.filter((field) => !ids.includes(field.id));
  function move(index, offset) {
    const next = [...ids];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    onChange(next);
  }
  return (
    <div className="display-field-picker">
      <CardDescription>Поля в порядке отображения</CardDescription>
      {ids.map((id, index) => {
        const field = fields.find((field) => field.id === id);
        return (
          <div className="display-field-picker-row" key={id}>
            <CardDescription>
              {field.label}
              {!field.value ? " • нет данных" : ""}
            </CardDescription>
            <div className="display-field-picker-actions">
              {onBreakChange && (
                <Button
                  size="sm"
                  variant="toggle"
                  disabled={index === 0}
                  aria-pressed={index > 0 && breakBefore.includes(id)}
                  aria-label={`${field.label}: с новой строки`}
                  title="С новой строки"
                  onClick={() =>
                    onBreakChange(
                      breakBefore.includes(id)
                        ? breakBefore.filter((key) => key !== id)
                        : [...breakBefore, id],
                    )
                  }
                >
                  ↵
                </Button>
              )}

              <Button
                size="sm"
                disabled={index === 0}
                aria-label={`${field.label}: выше`}
                onClick={() => move(index, -1)}
              >
                ↑
              </Button>
              <Button
                size="sm"
                disabled={index === ids.length - 1}
                aria-label={`${field.label}: ниже`}
                onClick={() => move(index, 1)}
              >
                ↓
              </Button>
              <Button
                size="sm"
                aria-label={`Убрать: ${field.label}`}
                onClick={() => onChange(ids.filter((key) => key !== id))}
              >
                ×
              </Button>
            </div>
          </div>
        );
      })}
      {!ids.length && <CardDescription>Поля не выбраны</CardDescription>}
      {remaining.length > 0 && (
        <Button
          size="sm"
          aria-expanded={adding}
          onClick={() => setAdding((value) => !value)}
        >
          {adding ? "Скрыть список" : "Добавить поле"}
        </Button>
      )}
      {adding && (
        <div className="display-field-picker">
          {remaining.map((field) => (
            <Button
              key={field.id}
              size="sm"
              onClick={() => {
                onChange([...ids, field.id]);
                setAdding(false);
              }}
            >
              {field.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
