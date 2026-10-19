import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";

export function BusinessItemTile({ itemId, labelled = true, size = 64 }) {
  const label = `Предмет бизнеса №${itemId}`;
  return (
    <ImageCard
      src={
        itemId
          ? `https://cdn.cargohustle.online/V3/items/${itemId}.webp`
          : undefined
      }
      size={size}
      label={labelled ? label : undefined}
      alt={labelled ? label : ""}
    />
  );
}
