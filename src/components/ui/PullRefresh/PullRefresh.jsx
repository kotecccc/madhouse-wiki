import "./PullRefresh.css";

export function PullRefresh({ progress, touching }) {
  return (
    <div
      className={`ui-pull-refresh${touching ? " ui-pull-refresh--dragging" : ""}`}
      style={{ height: progress * 32 }}
      role="progressbar"
      aria-label="Потяните для обновления"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      aria-hidden={progress === 0}
    >
      <span
        className="ui-pull-refresh-icon"
        style={{
          transform: `scale(${progress})`,
        }}
      >
        <svg
          className="ui-pull-refresh-ring"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle
            cx="12"
            cy="12"
            r="10"
            pathLength="100"
            strokeDasharray={`${(1 - progress) * 100} 100`}
          />
        </svg>
      </span>
    </div>
  );
}
