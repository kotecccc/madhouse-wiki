import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import "./BossPortrait.css";

export function BossPortrait({ src, alt = "", onHeight }) {
  const portraitRef = useRef(null);
  useLayoutEffect(() => {
    const portrait = portraitRef.current;
    if (!portrait || !onHeight) return;
    const updateHeight = () =>
      onHeight(portrait.getBoundingClientRect().height);
    const observer = new ResizeObserver(updateHeight);
    observer.observe(portrait);
    updateHeight();
    return () => observer.disconnect();
  }, [src, onHeight]);
  if (!src) return null;

  return (
    <BaseCard
      as="span"
      variant="image"
      className="boss-portrait"
      ref={portraitRef}
    >
      <img src={src} alt={alt} loading="lazy" />
    </BaseCard>
  );
}
import { useLayoutEffect, useRef } from "react";
