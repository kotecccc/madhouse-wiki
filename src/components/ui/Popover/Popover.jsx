import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BaseCard } from "../BaseCard/BaseCard.jsx";
import "./Popover.css";

export function Popover({ anchor, point, onClose, children, label }) {
  const popoverRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const [position, setPosition] = useState(null);
  onCloseRef.current = onClose;

  const updatePosition = useCallback(() => {
    const popover = popoverRef.current;
    const hasPoint = Number.isFinite(point?.x) && Number.isFinite(point?.y);
    if ((!anchor && !hasPoint) || !popover) return;

    const popoverRect = popover.getBoundingClientRect();
    const gap =
      Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--space-8",
        ),
      ) || 0;
    let preferredLeft;
    let preferredTop;
    if (hasPoint) {
      const rightSpace = window.innerWidth - point.x;
      const leftSpace = point.x;
      const placeRight =
        rightSpace >= popoverRect.width + gap || rightSpace >= leftSpace;
      const belowSpace = window.innerHeight - point.y;
      const aboveSpace = point.y;
      const placeBelow =
        belowSpace >= popoverRect.height + gap || belowSpace >= aboveSpace;
      preferredLeft = placeRight
        ? point.x + gap
        : point.x - popoverRect.width - gap;
      preferredTop = placeBelow
        ? point.y + gap
        : point.y - popoverRect.height - gap;
    } else {
      const anchorRect = anchor.getBoundingClientRect();
      const rightSpace = window.innerWidth - anchorRect.right;
      const leftSpace = anchorRect.left;
      const placeRight =
        rightSpace >= popoverRect.width + gap || rightSpace >= leftSpace;
      preferredLeft = placeRight
        ? anchorRect.right + gap
        : anchorRect.left - popoverRect.width - gap;
      preferredTop = anchorRect.top;
    }
    const left = Math.max(
      0,
      Math.min(preferredLeft, window.innerWidth - popoverRect.width),
    );
    const top = Math.max(
      0,
      Math.min(preferredTop, window.innerHeight - popoverRect.height),
    );
    setPosition({ left, top });
  }, [anchor, point]);

  useLayoutEffect(() => {
    updatePosition();
    const popover = popoverRef.current;
    if (!popover) return undefined;

    const observer = new ResizeObserver(updatePosition);
    observer.observe(popover);
    if (anchor) observer.observe(anchor);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchor, updatePosition]);

  const positioned = position !== null;
  useLayoutEffect(() => {
    const popover = popoverRef.current;
    if (!positioned || !popover) return;
    const firstControl = popover.querySelector(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    );
    (firstControl || popover).focus({ preventScroll: true });
  }, [anchor, positioned]);

  useLayoutEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      anchor?.focus?.({ preventScroll: true });
      onCloseRef.current?.("escape");
    };
    const onPointerDown = (event) => {
      if (
        popoverRef.current?.contains(event.target) ||
        anchor?.contains?.(event.target)
      )
        return;
      onCloseRef.current?.("outside");
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [anchor]);

  return createPortal(
    <BaseCard
      ref={popoverRef}
      as="div"
      variant="popover"
      padding="8"
      className="ui-popover"
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? "visible" : "hidden",
      }}
    >
      {children}
    </BaseCard>,
    anchor?.closest?.("dialog[open]") ?? document.body,
  );
}
