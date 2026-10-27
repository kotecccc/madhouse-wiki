import { useEffect, useRef } from "react";
import { observeVisibility } from "./visibility-observer.js";
import { Button } from "../../components/ui/Button/Button.jsx";

export function InventoryLoadMore({ remaining, onLoad, active }) {
  const sentinel = useRef(null);
  const loadRef = useRef(onLoad);
  useEffect(() => {
    loadRef.current = onLoad;
  }, [onLoad]);
  useEffect(() => {
    if (!active) return;
    return observeVisibility(sentinel.current, (visible) => {
      if (visible) loadRef.current();
    });
  }, [active, remaining]);
  return (
    <div ref={sentinel}>
      <Button onClick={onLoad}>Показать ещё ({remaining})</Button>
    </div>
  );
}
