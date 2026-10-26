import { useCardEditing } from "../CardEditing/CardEditing.jsx";
import "./ImageCard.css";
import { useState } from "react";
import { BaseCard } from "../BaseCard/BaseCard.jsx";
import { Icon } from "../Icon/Icon.jsx";

const IMAGE_SIZE_TOKENS = [4, 8, 12, 16, 24, 32, 40, 48, 64];
const LOADED_IMAGES_LIMIT = 2000;
const loadedImages = new Set();

function rememberLoadedImage(src) {
  loadedImages.delete(src);
  loadedImages.add(src);
  if (loadedImages.size > LOADED_IMAGES_LIMIT)
    loadedImages.delete(loadedImages.values().next().value);
}

function forgetLoadedImage(src) {
  loadedImages.delete(src);
}

function asCssLength(value) {
  if (typeof value !== "number") return value;

  const tokenSize = IMAGE_SIZE_TOKENS.reduce((closest, candidate) =>
    Math.abs(candidate - value) < Math.abs(closest - value)
      ? candidate
      : closest,
  );

  return `var(--space-${tokenSize})`;
}

export function ImageCard({
  variant,
  src,
  alt = "",
  label,
  title,
  size = 64,
  imageSize = typeof size === "number" ? size - 16 : "var(--space-48)",
  className = "",
  children,
  as = "span",
  loading = "lazy",
  editKey,
}) {
  const editing = useCardEditing(editKey, "image", {
    size: asCssLength(size),
    imageSize: asCssLength(imageSize),
  });
  if (editing.active) {
    size = editing.values.size;
    imageSize = editing.values.imageSize;
  }
  const [failedSrc, setFailedSrc] = useState(null);
  const [loadedSrc, setLoadedSrc] = useState(() =>
    loadedImages.has(src) ? src : null,
  );
  const imageFailed = Boolean(src) && failedSrc === src;
  const showImage = Boolean(src) && !imageFailed;
  const imageLoaded = showImage && (loadedSrc === src || loadedImages.has(src));
  const variantClass =
    variant === "landscape"
      ? "image-card--landscape"
      : variant === "avatar"
        ? "image-card--avatar"
        : "";

  return (
    <BaseCard
      as={as}
      variant="image"
      className={`image-card ${variantClass} ${className} ${editing.className}`}
      aria-label={label}
      title={title}
      {...editing.targetProps}
      style={{
        "--image-card-size": asCssLength(size),
        "--image-card-image-size": asCssLength(imageSize),
      }}
    >
      {showImage && (
        <img
          src={src}
          alt={alt}
          loading={loading}
          onLoad={() => {
            setFailedSrc(null);
            rememberLoadedImage(src);
            setLoadedSrc(src);
          }}
          onError={() => {
            forgetLoadedImage(src);
            setFailedSrc(src);
          }}
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
