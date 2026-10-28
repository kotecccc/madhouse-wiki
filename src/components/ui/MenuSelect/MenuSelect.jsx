import { useRef, useState } from "react";
import { Button } from "../Button/Button.jsx";
import { CardActionMenu } from "../CardActionMenu/CardActionMenu.jsx";
import { Icon } from "../Icon/Icon.jsx";
import "./MenuSelect.css";

export function MenuSelect({ label, options, value, onChange }) {
  const anchor = useRef(null);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const selected = options.find((option) => option.value === value);
  const finish = () => {
    setOpen(false);
    setClosing(false);
  };
  const close = () => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
      finish();
    else setClosing(true);
  };
  return (
    <div className="menu-select" ref={anchor} tabIndex={-1}>
      <Button
        className="menu-select-trigger"
        variant="field"
        aria-label={`${label}: ${selected?.label ?? ""}`}
        aria-haspopup="dialog"
        aria-expanded={open && !closing}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Icon type="sort" size="small" />
        <span className="menu-select-value">{selected?.label}</span>
        <Icon type="chevron" size="small" />
      </Button>
      {open && (
        <CardActionMenu
          anchor={anchor.current}
          label={label}
          onClose={close}
          closing={closing}
          onClosed={finish}
          preferFit
          fullWidth
        >
          {options.map((option) => (
            <Button
              key={option.value}
              variant="menu-item"
              icon={option.icon}
              aria-pressed={value === option.value}
              onClick={() => {
                onChange(option.value);
                close();
              }}
            >
              {option.label}
            </Button>
          ))}
        </CardActionMenu>
      )}
    </div>
  );
}
