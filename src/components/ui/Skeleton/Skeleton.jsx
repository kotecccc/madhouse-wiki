import "./Skeleton.css";

export function Skeleton({ variant = "text" }) {
  return (
    <span
      className={`ui-skeleton ui-skeleton--${variant}`}
      aria-hidden="true"
    />
  );
}
