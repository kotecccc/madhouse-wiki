import { Icon } from "../Icon/Icon.jsx";
import "./Wallet.css";

const numberFormat = new Intl.NumberFormat("ru-RU");

export function Wallet({ entries }) {
  return (
    <dl className="ui-wallet" aria-label="Баланс валют">
      {entries.map(([label, value, icon]) => (
        <div key={label}>
          <dt>
            <Icon type={icon} size="small" />
            {label}
          </dt>
          <dd>{Number.isFinite(value) ? numberFormat.format(value) : "—"}</dd>
        </div>
      ))}
    </dl>
  );
}
