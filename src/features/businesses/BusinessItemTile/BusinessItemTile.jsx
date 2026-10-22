import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";

export function BusinessItemTile({
  itemId,
  src,
  name,
  labelled = true,
  size = 64,
  imageSize,
  loading = "lazy",
  editKey,
}) {
  const label = name || `Предмет бизнеса №${itemId}`;
  return (
    <ImageCard
      editKey={editKey}
      src={
        src ||
        (itemId
          ? `https://cdn.cargohustle.online/V3/items/${itemId}.webp`
          : undefined)
      }
      size={size}
      imageSize={imageSize}
      loading={loading}
      label={labelled ? label : undefined}
      alt={labelled ? label : ""}
    />
  );
}
