import "./Dialog.css";
import { useEffect, useRef } from "react";

// These are non-modal dialogs, matching the existing page layout and dismissal behavior.
export function Dialog({ onClose, children, className = "", ...props }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.querySelector("button")?.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      {...props}
      className={`ui-dialog ${className}`.trim()}
      ref={ref}
      open
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
