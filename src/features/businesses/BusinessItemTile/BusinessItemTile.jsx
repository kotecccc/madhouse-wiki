import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";

export function BusinessItemTile({
  itemId,
  name,
  labelled = true,
  size = 64,
  imageSize,
}) {
  const label = name || `Предмет бизнеса №${itemId}`;
  return (
    <ImageCard
      src={
        itemId
          ? `https://cdn.cargohustle.online/V3/items/${itemId}.webp`
          : undefined
      }
      size={size}
      imageSize={imageSize}
      label={labelled ? label : undefined}
      alt={labelled ? label : ""}
    />
  );
}
