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
  size = "md",
  titleSize,
  descriptionSize,
  leading,
  status,
  defaultOpen = false,
  children,
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <BaseCard
      as="details"
      className={`ui-disclosure${size === "sm" ? " ui-disclosure--sm" : ""}`}
      padding={size === "sm" ? "12" : undefined}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        className={`ui-disclosure-summary${leading ? " ui-disclosure-summary--leading" : ""}${status ? " ui-disclosure-summary--status" : ""}`}
      >
        {leading}
        {leading || status ? (
          <span className="ui-disclosure-copy">
            <CardTitle
              as="span"
              size={titleSize ?? (size === "sm" ? "sm" : undefined)}
            >
              {title}
            </CardTitle>
            {(count != null || description) && (
              <CardDescription
                size={descriptionSize ?? (size === "sm" ? "xs" : undefined)}
                title={countLabel}
                aria-label={countLabel}
              >
                {count ?? description}
              </CardDescription>
            )}
          </span>
        ) : (
          <>
            <CardTitle
              as="span"
              size={titleSize ?? (size === "sm" ? "sm" : undefined)}
            >
              {title}
            </CardTitle>
            <CardDescription
              size={descriptionSize ?? (size === "sm" ? "xs" : undefined)}
              title={countLabel}
              aria-label={countLabel}
            >
              {count ?? description}
            </CardDescription>
          </>
        )}
        {status}
        <span className="ui-disclosure-chevron">
          <Icon type="chevron" size="medium" />
        </span>
      </summary>
      {open && <div className="ui-disclosure-content">{children}</div>}
    </BaseCard>
  );
}
