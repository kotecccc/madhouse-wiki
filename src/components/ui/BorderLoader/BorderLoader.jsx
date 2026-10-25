import "./BorderLoader.css";

export function BorderLoader({ label = "Загрузка" }) {
  return (
    <span className="ui-border-loader" role="progressbar" aria-label={label} />
  );
}
