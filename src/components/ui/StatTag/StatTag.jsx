import { useState } from "react";
import { Button } from "../Button/Button.jsx";
import { Icon } from "../Icon/Icon.jsx";
import { Popover } from "../Popover/Popover.jsx";
import { CardTitle } from "../CardTitle/CardTitle.jsx";
import { CardDescription } from "../CardDescription/CardDescription.jsx";
import "./StatTag.css";

export function StatTag({
  icon,
  label,
  description,
  details = [],
  mutagenType,
  inactive = false,
  size = "default",
  statTarget,
}) {
  const [anchor, setAnchor] = useState(null);
  const hint = [description, ...details].filter(Boolean).join("\n");
  return (
    <>
      <Button
        variant="text-tag"
        data-stat-target={statTarget}
        className={[
          size === "compact" && "stat-tag--compact",
          size === "responsive-compact" && "stat-tag--responsive-compact",
        ]
          .filter(Boolean)
          .join(" ")}
        liftOnHover={false}
        title={hint}
        aria-label={description}
        aria-haspopup="dialog"
        aria-expanded={Boolean(anchor)}
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
      >
        {inactive ? (
          <s>
            <Icon type={icon} size="text" mutagenType={mutagenType} />
            {label}
          </s>
        ) : (
          <>
            <Icon type={icon} size="text" mutagenType={mutagenType} />
            {label}
          </>
        )}
      </Button>
      {anchor && (
        <Popover
          anchor={anchor}
          label={description}
          onClose={() => setAnchor(null)}
        >
          <CardTitle size="sm">{description}</CardTitle>
          {details.map((detail, index) => (
            <CardDescription size="sm" key={index}>
              {detail}
            </CardDescription>
          ))}
        </Popover>
      )}
    </>
  );
}
