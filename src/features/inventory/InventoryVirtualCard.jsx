import { useEffect, useRef, useState } from "react";
import { Skeleton } from "../../components/ui/Skeleton/Skeleton.jsx";
import { observeVisibility } from "./visibility-observer.js";
import { InventoryItemCard } from "./InventoryItemCard.jsx";

// Keep measured space when a card leaves the viewport, so the surrounding grid
// and the scroll position remain stable. Focused cards stay mounted.
export function InventoryVirtualCard({ item, onAction, equipmentBusy }) {
  const wrapper = useRef(null);
  const [visible, setVisible] = useState(true);
  const [focused, setFocused] = useState(false);
  const [height, setHeight] = useState(null);
  const mounted = visible || focused || height === null;

  useEffect(() => {
    return observeVisibility(wrapper.current, setVisible, {
      rootMargin: "100% 0px",
    });
  }, []);

  useEffect(() => {
    if (!mounted || !wrapper.current) return;
    const element = wrapper.current;
    const measure = () => {
      const next = element.getBoundingClientRect().height;
      if (next > 0) setHeight((current) => (current === next ? current : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mounted]);

  return (
    <div
      ref={wrapper}
      className="inventory-virtual-card"
      style={mounted ? undefined : { height }}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      }}
    >
      {mounted ? (
        <InventoryItemCard
          item={item}
          onAction={onAction}
          equipmentBusy={equipmentBusy}
        />
      ) : (
        <Skeleton as="article" />
      )}
    </div>
  );
}
