import { useContext, useSyncExternalStore } from "react";
import { CardEditingContext } from "../CardEditing/CardEditing.jsx";

const mobileQuery = "(max-width: 650px)";
const subscribe = (onChange) => {
  const query = window.matchMedia(mobileQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
const getMobile = () => window.matchMedia(mobileQuery).matches;
const getServerMobile = () => false;

export function useMobileCardAction({ enabled = true, onActivate, label }) {
  const editing = useContext(CardEditingContext);
  const matches = useSyncExternalStore(subscribe, getMobile, getServerMobile);
  const mobile = matches && !editing;
  const active = mobile && enabled;
  return {
    mobile,
    cardProps: active ? mobileCardActionProps({ onActivate, label }) : {},
  };
}

export function mobileCardActionProps({ onActivate, label }) {
  return {
    role: "button",
    tabIndex: 0,
    "aria-label": label,
    "aria-haspopup": "dialog",
    onClick: (event) => {
      if (event.defaultPrevented) return;
      const interactive = event.target.closest?.(
        "button, a, input, select, textarea, summary, dialog, [role=button]",
      );
      if (interactive && interactive !== event.currentTarget) return;
      onActivate();
    },
    onKeyDown: (event) => {
      if (event.target !== event.currentTarget || event.defaultPrevented)
        return;
      if (["Enter", " "].includes(event.key)) {
        event.preventDefault();
        onActivate();
      }
    },
  };
}
