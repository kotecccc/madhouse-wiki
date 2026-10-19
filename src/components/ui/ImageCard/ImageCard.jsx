import "./ImageCard.css";
import { BaseCard } from "../BaseCard/BaseCard.jsx";

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
      {src ? (
        <img src={src} alt={alt} loading="lazy" />
      ) : (
        children
      )}
    </BaseCard>
  );
}
