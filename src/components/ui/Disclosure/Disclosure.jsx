import { useState } from "react";
import { BaseCard } from "../BaseCard/BaseCard.jsx";
import { CardTitle } from "../CardTitle/CardTitle.jsx";
import { CardDescription } from "../CardDescription/CardDescription.jsx";
import { Icon } from "../Icon/Icon.jsx";
import "./Disclosure.css";

export function Disclosure({
  title,
  count,
  countLabel,
  description,
  defaultOpen = false,
  children,
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <BaseCard
      as="details"
      className="ui-disclosure"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="ui-disclosure-summary">
        <CardTitle as="span">{title}</CardTitle>
        <CardDescription title={countLabel} aria-label={countLabel}>
          {count ?? description}
        </CardDescription>
        <span className="ui-disclosure-chevron">
          <Icon type="chevron" size="medium" />
        </span>
      </summary>
      {open && <div className="ui-disclosure-content">{children}</div>}
    </BaseCard>
  );
}
