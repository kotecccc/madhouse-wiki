export function menuScrollDistance(card, menu, viewport, overlay, spacing = 0) {
  const top = Math.min(card.top, menu.top);
  const bottom = Math.max(card.bottom, menu.bottom);
  const intersectsOverlayHorizontally =
    overlay &&
    overlay.width > 0 &&
    overlay.height > 0 &&
    [card, menu].some(
      (rect) => rect.left < overlay.right && rect.right > overlay.left,
    );
  const bottomLimit =
    intersectsOverlayHorizontally &&
    overlay.top < viewport.bottom &&
    overlay.bottom > viewport.top
      ? Math.min(viewport.bottom, overlay.top)
      : viewport.bottom;
  const availableSpacing = Math.max(
    0,
    bottomLimit - viewport.top - (bottom - top),
  );
  const extra = Math.min(Math.max(0, spacing), availableSpacing);
  if (top < viewport.top) return top - viewport.top - extra;
  if (bottom > bottomLimit) return bottom - bottomLimit + extra;
  return 0;
}
