import { useState } from "react";
import { Button } from "../Button/Button.jsx";
import { Icon } from "../Icon/Icon.jsx";
import { Popover } from "../Popover/Popover.jsx";
import { CardTitle } from "../CardTitle/CardTitle.jsx";
import "./InfoButton.css";

export function InfoButton({ label, description }) {
  const [anchor, setAnchor] = useState(null);
  const open = Boolean(anchor);

  return (
    <>
      <Button
        variant="icon-copy-inline"
        liftOnHover={false}
        aria-label={label}
        title={`${label}: ${description}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          const target = event.currentTarget;
          setAnchor((current) => (current === target ? null : target));
        }}
      >
        <Icon type="info" size="text" />
      </Button>
      {anchor && (
        <Popover anchor={anchor} label={label} onClose={() => setAnchor(null)}>
          <div className="ui-info-content">
            <CardTitle size="sm">{label}</CardTitle>
            <p className="ui-info-description">{description}</p>
          </div>
        </Popover>
      )}
    </>
  );
}
