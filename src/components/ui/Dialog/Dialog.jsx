import "./Dialog.css";
import { useEffect, useRef } from "react";
import { BaseCard } from "../BaseCard/BaseCard.jsx";

const modalScrollLocks = new Set();
let restorePageScroll;

function lockPageScroll() {
  const lock = Symbol();
  if (modalScrollLocks.size === 0) {
    const elements = [
      document.documentElement,
      document.body,
      ...document.querySelectorAll("[data-page-scroll]"),
    ];
    const html = document.documentElement;
    const clearMobileScrollbarGutter =
      window.matchMedia("(max-width: 650px)").matches;
    const scrollbarGutter = {
      value: html.style.getPropertyValue("scrollbar-gutter"),
      priority: html.style.getPropertyPriority("scrollbar-gutter"),
    };
    const previous = elements.map((element) => ({
      element,
      overflow: element.style.getPropertyValue("overflow"),
      priority: element.style.getPropertyPriority("overflow"),
    }));
    elements.forEach((element) =>
      element.style.setProperty("overflow", "hidden"),
    );
    if (clearMobileScrollbarGutter)
      html.style.setProperty("scrollbar-gutter", "auto");
    restorePageScroll = () => {
      previous.forEach(({ element, overflow, priority }) => {
        if (overflow) element.style.setProperty("overflow", overflow, priority);
        else element.style.removeProperty("overflow");
      });
      if (clearMobileScrollbarGutter) {
        if (scrollbarGutter.value)
          html.style.setProperty(
            "scrollbar-gutter",
            scrollbarGutter.value,
            scrollbarGutter.priority,
          );
        else html.style.removeProperty("scrollbar-gutter");
      }
    };
  }
  modalScrollLocks.add(lock);
  return () => {
    modalScrollLocks.delete(lock);
    if (modalScrollLocks.size === 0) restorePageScroll();
  };
}

// Modal presentation is opt-in so existing inline dialogs retain their layout.
export function Dialog({
  onClose,
  children,
  className = "",
  modal = false,
  visible = true,
  surface,
  ...props
}) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const restoreKeyboardFocus = previous?.matches(":focus-visible");
    const dialog = ref.current;
    if (!dialog || !visible) return;
    if (modal && !dialog.open) dialog.showModal();
    const unlockScroll = modal ? lockPageScroll() : undefined;
    const autofocus = dialog.querySelector("[autofocus]");
    (autofocus || (modal ? dialog : dialog.querySelector("button")))?.focus({
      preventScroll: true,
    });
    return () => {
      if (modal && dialog.open) dialog.close();
      unlockScroll?.();
      if (restoreKeyboardFocus && previous?.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, [modal, visible]);
  const Surface = surface ? BaseCard : "dialog";
  return (
    <Surface
      {...(surface ? { as: "dialog", variant: surface } : {})}
      {...props}
      className={`ui-dialog ${className}`.trim()}
      ref={ref}
      hidden={!visible}
      tabIndex={modal ? -1 : undefined}
      open={modal ? undefined : visible}
      onKeyDown={(event) => {
        if (!modal && event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {children}
    </Surface>
  );
}
