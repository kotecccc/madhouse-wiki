import { composeDisplayFields } from "../../../lib/card-display-fields.js";
import { renderDisplayFields } from "./DisplayFields.jsx";
import { createContext, useContext } from "react";
import { editableTargetProps } from "../EditableTarget/EditableTarget.js";

export const CardEditingContext = createContext(null);
export function CardEditScope({ scope, children }) {
  const context = useContext(CardEditingContext);
  if (!context) return children;
  return (
    <CardEditingContext.Provider
      value={{ ...context, scope: `${context.scope}/${scope}` }}
    >
      {children}
    </CardEditingContext.Provider>
  );
}
export function useCardEditing(editKey, kind, defaults, composition) {
  const context = useContext(CardEditingContext);
  if (!context || !editKey)
    return { values: defaults, targetProps: {}, className: "" };
  const key = `${context.scope}/${editKey}`;
  const values = { ...defaults, ...context.fields[key]?.props };
  if (
    composition &&
    (Array.isArray(values.displayFields) || Array.isArray(values.breakBefore))
  ) {
    const selected = values.displayFields ?? composition.defaultFields;
    values.text = composeDisplayFields(composition.fields, selected);
    values.content = renderDisplayFields(
      composition.fields,
      selected,
      kind === "description" ? values.breakBefore : [],
    );
  }
  const activate = (event) => {
    // A surrounding editable layout must not swallow native disclosure controls.
    const interactive = event.target.closest?.(
      "summary, button, a, input, select, textarea, [role=button]",
    );
    if (kind === "card" && interactive && interactive !== event.currentTarget)
      return;
    event.preventDefault();
    event.stopPropagation();
    context.open({
      key,
      kind,
      defaults,
      composition,
      anchor: event.currentTarget,
      point:
        event.type === "click" && event.detail > 0
          ? { x: event.clientX, y: event.clientY }
          : undefined,
    });
  };
  return {
    active: true,
    editable: !context.readOnly,
    overrides: context.fields[key]?.props || {},
    values,
    className: editableTargetProps(!context.readOnly).className,
    targetProps: context.readOnly
      ? {}
      : {
          role: "button",
          tabIndex: 0,
          "aria-haspopup": "dialog",
          title: "Настроить элемент",
          onClick: activate,
          onKeyDown: (event) => {
            if (
              event.target === event.currentTarget &&
              ["Enter", " "].includes(event.key)
            )
              activate(event);
          },
        },
  };
}
export function editableText(children) {
  return typeof children === "string" || typeof children === "number"
    ? { text: String(children) }
    : {};
}
