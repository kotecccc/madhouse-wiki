import { useEffect, useLayoutEffect, useRef } from "react";
import { BaseCard } from "../BaseCard/BaseCard.jsx";
import { menuScrollDistance } from "./menu-visibility.js";
import "./CardActionMenu.css";

export function CardActionMenu({
  anchor,
  label,
  onClose,
  closing,
  onClosed,
  preferFit = false,
  children,
}) {
  const menu = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    (element.querySelector("button:not(:disabled)") || element).focus({
      preventScroll: true,
    });
    const scrollContainer =
      anchor.closest(".shared-modal-content") ||
      anchor.closest("[data-page-scroll]");
    const scrollBounds = scrollContainer?.getBoundingClientRect();
    const viewport =
      scrollBounds?.width && scrollBounds?.height
        ? {
            top: Math.max(0, scrollBounds.top),
            bottom: Math.min(window.innerHeight, scrollBounds.bottom),
            left: Math.max(0, scrollBounds.left),
            right: Math.min(window.innerWidth, scrollBounds.right),
          }
        : {
            top: 0,
            left: 0,
            bottom: window.innerHeight,
            right: window.innerWidth,
          };
    const navigation = anchor.closest("dialog[open]")
      ? null
      : document.querySelector(".bottom-dock .mobile-navigation");
    const spacing =
      Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--space-8",
        ),
      ) || 0;
    if (preferFit) {
      const card = anchor.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      const bottom = Math.min(
        viewport.bottom,
        navigation?.getBoundingClientRect().top ?? viewport.bottom,
      );
      if (
        bounds.bottom > bottom &&
        card.top - bounds.height - spacing >= viewport.top
      ) {
        element.style.top = "auto";
        element.style.bottom = "100%";
        element.style.marginTop = "0";
        element.style.marginBottom = "var(--space-8)";
      }
    }
    const distance = menuScrollDistance(
      anchor.getBoundingClientRect(),
      element.getBoundingClientRect(),
      viewport,
      navigation?.getBoundingClientRect(),
      spacing,
    );
    if (distance) {
      const reducedMotion = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      const scrollTarget =
        scrollBounds?.width && scrollBounds?.height ? scrollContainer : window;
      scrollTarget.scrollBy({
        top: distance,
        behavior: reducedMotion ? "instant" : "smooth",
      });
    }
  }, [anchor, preferFit]);
  useEffect(() => {
    const pointerDown = (event) => {
      if (
        !menu.current?.contains(event.target) &&
        !anchor.contains(event.target)
      )
        onCloseRef.current();
    };
    const keyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCloseRef.current();
      anchor.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", pointerDown);
    document.addEventListener("keydown", keyDown);
    return () => {
      document.removeEventListener("pointerdown", pointerDown);
      document.removeEventListener("keydown", keyDown);
    };
  }, [anchor]);
  return (
    <BaseCard
      ref={menu}
      variant="glass-menu"
      className="card-action-menu"
      role="dialog"
      tabIndex={-1}
      data-motion={closing ? "closing" : "opening"}
      aria-hidden={closing}
      inert={closing}
      onAnimationEnd={(event) => {
        if (closing && event.target === event.currentTarget) onClosed();
      }}
      aria-label={label}
    >
      {children}
    </BaseCard>
  );
}
