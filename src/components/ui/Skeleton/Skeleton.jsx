import { useLayoutEffect, useRef } from "react";
import { BaseCard } from "../BaseCard/BaseCard.jsx";
import { Button } from "../Button/Button.jsx";
import "./Skeleton.css";

export function Skeleton({ variant = "card", className = "", as = "div" }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    // Share the document timeline so later-mounted placeholders join the
    // existing pulse instead of starting a separate animation phase.
    for (const animation of ref.current?.getAnimations?.() || []) {
      if (animation.animationName === "skeleton-pulse") animation.startTime = 0;
    }
  }, []);
  const props = {
    ref,
    className: `ui-skeleton ${className}`.trim(),
    "aria-hidden": true,
    children: (
      <span className={`ui-skeleton-space ui-skeleton-space--${variant}`} />
    ),
  };
  if (variant === "text" || variant === "progress") {
    return (
      <span
        ref={ref}
        className={`ui-skeleton ui-skeleton-${variant} ${className}`.trim()}
        aria-hidden="true"
      />
    );
  }
  if (variant === "profile") {
    return (
      <BaseCard
        ref={ref}
        as={as}
        padding="4"
        className={`ui-skeleton ui-skeleton-profile ${className}`.trim()}
        aria-hidden="true"
      >
        <span className="ui-skeleton-profile-avatar" />
        <span className="ui-skeleton-profile-copy">
          <span className="ui-skeleton-profile-name" />
          <span className="ui-skeleton-profile-detail" />
        </span>
      </BaseCard>
    );
  }
  return variant === "card" ? (
    <BaseCard {...props} as={as} variant="floor-data" />
  ) : (
    <Button {...props} disabled size={variant === "control" ? "lg" : "md"} />
  );
}
