import { BorderLoader } from "../BorderLoader/BorderLoader.jsx";
import { useId, useRef, useState } from "react";
import { isPullReady, refreshModal } from "./pull-refresh.js";
import { ToastTargetContext } from "../Toast/ToastContext.jsx";
import { Dialog } from "../Dialog/Dialog.jsx";
import { Title } from "../Title/Title.jsx";
import { Button } from "../Button/Button.jsx";
import { DialogCloseButton } from "../DialogCloseButton/DialogCloseButton.jsx";
import "./Modal.css";

export function Modal({
  title,
  description,
  titleId,
  onClose,
  children,
  contentBottom,
  footer,
  footerNote,
  footerStart,
  className = "",
  width,
  showCloseButton = true,
  contentScrollable = true,
  contentVariant = "default",
  contentAlignment = "start",
  visible = true,
  loading = false,
  onRefresh,
  refreshKey,
}) {
  const [toastTarget, setToastTarget] = useState(null);
  const generatedId = useId();
  const id = titleId || generatedId;
  const pull = useRef(null);
  const [pullReady, setPullReady] = useState(false);
  const [pullLoading, setPullLoading] = useState(false);
  async function runRefresh() {
    if (!onRefresh || loading) return;
    try {
      await refreshModal(refreshKey || title, async () => {
        setPullLoading(true);
        try {
          await onRefresh();
        } finally {
          setPullLoading(false);
        }
      });
    } catch {
      // The owning feature reports its own refresh errors.
    }
  }
  function startPull(event) {
    pull.current = null;
    setPullReady(false);
    if (
      !onRefresh ||
      event.touches.length !== 1 ||
      event.currentTarget.scrollTop > 0 ||
      event.target.closest("button, input, textarea, select, a")
    )
      return;
    pull.current = {
      x: event.touches[0].clientX,
      y: event.touches[0].clientY,
      ready: false,
    };
  }
  function movePull(event) {
    if (!pull.current || event.touches.length !== 1) return;
    pull.current.ready = isPullReady({
      startX: pull.current.x,
      startY: pull.current.y,
      x: event.touches[0].clientX,
      y: event.touches[0].clientY,
      scrollTop: event.currentTarget.scrollTop,
    });
    setPullReady(pull.current.ready);
  }
  function endPull(event) {
    const ready = event.touches.length === 0 && pull.current?.ready;
    pull.current = null;
    setPullReady(false);
    if (ready) void runRefresh();
  }
  return (
    <Dialog
      modal
      visible={visible}
      surface="modal"
      className={`shared-modal${footer === false ? " shared-modal--no-footer" : ""}${contentVariant === "inset" ? " shared-modal--inset" : ""} ${className}`.trim()}
      aria-labelledby={id}
      aria-busy={loading || undefined}
      onClose={onClose}
      style={
        width
          ? {
              "--dialog-width":
                typeof width === "number" ? `${width}px` : width,
            }
          : undefined
      }
    >
      <ToastTargetContext.Provider value={toastTarget}>
        <header className="shared-modal-heading">
          <div className="shared-modal-heading-copy">
            <Title as="h2" id={id} className="shared-modal-title">
              {title}
            </Title>
            {description && (
              <p className="shared-modal-description">{description}</p>
            )}
          </div>
          {showCloseButton && <DialogCloseButton onClick={onClose} />}
          {(loading || pullLoading) && (
            <span className="shared-modal-heading-loader">
              <BorderLoader />
            </span>
          )}
        </header>
        <div
          tabIndex={onRefresh ? 0 : undefined}
          aria-keyshortcuts={onRefresh ? "R" : undefined}
          onTouchStart={startPull}
          onTouchMove={movePull}
          onTouchEnd={endPull}
          onTouchCancel={() => {
            pull.current = null;
            setPullReady(false);
          }}
          onKeyDown={(event) => {
            if (
              onRefresh &&
              event.key === "r" &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey &&
              !event.target.closest("input, textarea, select, button, a")
            ) {
              event.preventDefault();
              void runRefresh();
            }
          }}
          className={`shared-modal-content${
            contentVariant === "default"
              ? ""
              : ` shared-modal-content--${contentVariant}`
          }${contentAlignment === "center" ? " shared-modal-content--center" : ""}${contentScrollable ? "" : " shared-modal-content--unscrollable"}`}
        >
          {pullReady && <span role="status">Отпустите, чтобы обновить</span>}
          {contentAlignment === "center" ? (
            <div className="shared-modal-content-inner">{children}</div>
          ) : (
            children
          )}
          {contentBottom != null && (
            <div className="shared-modal-content-bottom">{contentBottom}</div>
          )}
        </div>
        <div className="shared-modal-toast-anchor">
          <div className="ui-toast-stack" ref={setToastTarget} />
        </div>
        {footer === false ? null : footerNote != null ? (
          <footer
            className={`shared-modal-footer shared-modal-footer--with-note${footerStart ? " shared-modal-footer--split" : ""}`}
          >
            {footerStart}
            <p
              className={`shared-modal-footer-note${footerStart ? " shared-modal-footer-note--center" : ""}`}
            >
              {footerNote}
            </p>
            {footer || <Button onClick={onClose}>Закрыть</Button>}
          </footer>
        ) : footer ? (
          <footer
            className={`shared-modal-footer${footerStart ? " shared-modal-footer--spread" : ""}`}
          >
            {footerStart}
            {footer}
          </footer>
        ) : (
          <footer className="shared-modal-footer shared-modal-mobile-footer">
            <Button onClick={onClose}>Закрыть</Button>
          </footer>
        )}
      </ToastTargetContext.Provider>
    </Dialog>
  );
}
