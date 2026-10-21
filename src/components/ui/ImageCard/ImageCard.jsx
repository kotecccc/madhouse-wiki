import "./ImageCard.css";
import { useState } from "react";
import { BaseCard } from "../BaseCard/BaseCard.jsx";
import { Icon } from "../Icon/Icon.jsx";

export function ImageCard({
  src,
  alt = "",
  label,
  title,
  size = 64,
  imageSize = size - 16,
  className = "",
  children,
  as = "span",
}) {
  const [failedSrc, setFailedSrc] = useState(null);
  const [loadedSrc, setLoadedSrc] = useState(null);
  const imageFailed = Boolean(src) && failedSrc === src;
  const showImage = Boolean(src) && !imageFailed;
  const imageLoaded = showImage && loadedSrc === src;
  const asCssLength = (value) =>
    typeof value === "number" ? `${value}px` : value;

  return (
    <BaseCard
      as={as}
      variant="image"
      className={`image-card ${className}`}
      aria-label={label}
      title={title}
      style={{
        "--image-card-size": asCssLength(size),
        "--image-card-image-size": asCssLength(imageSize),
      }}
    >
      {showImage && (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          onLoad={() => {
            setFailedSrc(null);
            setLoadedSrc(src);
          }}
          onError={() => setFailedSrc(src)}
        />
      )}
      {!imageLoaded && (
        <span className="image-card-placeholder" aria-hidden="true">
          {children || <Icon type="loot" />}
        </span>
      )}
    </BaseCard>
  );
}
