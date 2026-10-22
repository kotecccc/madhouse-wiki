import { useLayoutEffect, useRef, useState } from "react";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import "./BossPortrait.css";

export function BossPortrait({
  src,
  alt = "",
  onHeight,
  hasPortrait = true,
  loading = "lazy",
  className = "",
  ...props
}) {
  const portraitRef = useRef(null);
  const [failedSrc, setFailedSrc] = useState(null);
  const [loadedSrc, setLoadedSrc] = useState(null);
  const imageFailed = Boolean(src) && failedSrc === src;
  const showImage = Boolean(src) && !imageFailed;
  const imageLoaded = showImage && loadedSrc === src;

  useLayoutEffect(() => {
    const portrait = portraitRef.current;
    if (!portrait || !onHeight) return;
    const updateHeight = () =>
      onHeight(portrait.getBoundingClientRect().height);
    const observer = new ResizeObserver(updateHeight);
    observer.observe(portrait);
    updateHeight();
    return () => observer.disconnect();
  }, [src, onHeight, hasPortrait]);
  if (!hasPortrait) return null;

  return (
    <BaseCard
      {...props}
      as="span"
      variant="image"
      className={`boss-portrait${imageLoaded ? " boss-portrait--loaded" : " boss-portrait--placeholder"} ${className}`.trim()}
      ref={portraitRef}
    >
      {showImage && (
        <img
          src={src}
          alt={alt}
          loading={loading}
          onLoad={() => {
            setFailedSrc(null);
            setLoadedSrc(src);
          }}
          onError={() => setFailedSrc(src)}
        />
      )}
      {!imageLoaded && (
        <span className="boss-portrait-placeholder" aria-hidden="true">
          <Icon type="boss" />
        </span>
      )}
    </BaseCard>
  );
}
