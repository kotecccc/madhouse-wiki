export function isPullReady({ startX, startY, x, y, scrollTop }) {
  const horizontal = x - startX;
  const vertical = y - startY;
  return (
    scrollTop === 0 && vertical >= 80 && vertical > Math.abs(horizontal) * 1.3
  );
}
