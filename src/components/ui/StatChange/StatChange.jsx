import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { fmt } from "../../../lib/format.js";
import "./StatChange.css";

export function StatChange({ icon, delta, size = "default" }) {
  const [position, setPosition] = useState(null);
  useLayoutEffect(() => {
    const target = document.querySelector(`[data-stat-target="${icon}"]`);
    if (!target) return;
    function updatePosition() {
      const rect = target.getBoundingClientRect();
      setPosition({ x: rect.left + rect.width / 2, y: rect.bottom });
    }
    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [icon]);
  if (!position) return null;
  return createPortal(
    <span
      aria-hidden="true"
      className={`stat-change${delta < 0 ? " stat-change--negative" : ""}${size === "responsive-compact" ? " stat-change--responsive-compact" : ""}`}
      style={{ left: position.x, top: position.y }}
    >
      {delta > 0 ? "+" : "−"}
      {fmt(Math.abs(delta))}
    </span>,
    document.body,
  );
}
