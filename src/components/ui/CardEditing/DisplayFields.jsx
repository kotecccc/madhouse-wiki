import { Fragment } from "react";
import { splitDisplayFieldRows } from "../../../lib/card-display-fields.js";
import { fmt } from "../../../lib/format.js";
import { Icon } from "../Icon/Icon.jsx";
import "./DisplayFields.css";

export function renderDisplayFields(fields, ids, breakBefore = []) {
  return (
    <span className="display-field-lines">
      {splitDisplayFieldRows(fields, ids, breakBefore).map((row) => (
        <span className="display-fields" key={row[0].id}>
          {row.map((field, index) => (
            <Fragment key={field.id}>
              {index > 0 && <span aria-hidden="true"> • </span>}
              {field.rewards ? (
                field.rewards.map(([icon, label, amount], rewardIndex) => (
                  <Fragment key={icon}>
                    {rewardIndex > 0 && <span aria-hidden="true"> • </span>}
                    <span
                      className="display-field-reward"
                      aria-label={`${label}: ${fmt(amount)}`}
                      title={label}
                    >
                      <Icon type={icon} size="text" />{" "}
                      <span>{fmt(amount)}</span>
                    </span>
                  </Fragment>
                ))
              ) : (
                <span className="display-field-text">
                  {field.content ?? field.value}
                </span>
              )}
            </Fragment>
          ))}
        </span>
      ))}
    </span>
  );
}
