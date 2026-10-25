import "./StatusList.css";

const labels = {
  success: "Работает",
  error: "Ошибка",
  unknown: "Не проверено",
};

export function StatusList({ items, label = "Состояние сервисов" }) {
  return (
    <ul className="ui-status-list" aria-label={label}>
      {items.map((item) => {
        const status = Object.hasOwn(labels, item.status)
          ? item.status
          : "unknown";
        return (
          <li className="ui-status-list-row" key={item.id}>
            <span className="ui-status-list-label">
              <span
                className={`ui-status-list-dot ui-status-list-dot--${status}`}
                aria-hidden="true"
              />
              <span>{item.label}</span>
            </span>
            <span className="ui-status-list-status">{labels[status]}</span>
          </li>
        );
      })}
    </ul>
  );
}
