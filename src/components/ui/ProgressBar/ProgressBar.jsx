import "./ProgressBar.css";

export function ProgressBar({
  value,
  max,
  segments = 1,
  label,
  valueText,
  className = "",
}) {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 1;
  const safeValue = Number.isFinite(value)
    ? Math.min(safeMax, Math.max(0, value))
    : 0;
  const segmentCount =
    Number.isSafeInteger(segments) && segments > 0 ? segments : 1;
  const renderedSegments = segmentCount <= 100 ? segmentCount : 1;
  const segmentMax = safeMax / renderedSegments;

  return (
    <div
      className={`ui-progress-bar ${className}`.trim()}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={safeValue}
      aria-label={label}
      aria-valuetext={valueText}
    >
      {Array.from({ length: renderedSegments }, (_, index) => {
        const segmentStart = index * segmentMax;
        const segmentValue = Math.min(
          segmentMax,
          Math.max(0, safeValue - segmentStart),
        );
        return (
          <progress
            className="ui-progress-bar-segment"
            key={index}
            value={segmentValue}
            max={segmentMax}
            aria-hidden="true"
          />
        );
      })}
    </div>
  );
}
