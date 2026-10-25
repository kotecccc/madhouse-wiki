import { BorderLoader } from "../BorderLoader/BorderLoader.jsx";
import { useId } from "react";
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
}) {
  const generatedId = useId();
  const id = titleId || generatedId;
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
        {loading && (
          <span className="shared-modal-heading-loader">
            <BorderLoader />
          </span>
        )}
      </header>
      <div
        className={`shared-modal-content${
          contentVariant === "default"
            ? ""
            : ` shared-modal-content--${contentVariant}`
        }${contentAlignment === "center" ? " shared-modal-content--center" : ""}${contentScrollable ? "" : " shared-modal-content--unscrollable"}`}
      >
        {contentAlignment === "center" ? (
          <div className="shared-modal-content-inner">{children}</div>
        ) : (
          children
        )}
        {contentBottom != null && (
          <div className="shared-modal-content-bottom">{contentBottom}</div>
        )}
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
        <footer className="shared-modal-footer">{footer}</footer>
      ) : (
        <footer className="shared-modal-footer shared-modal-mobile-footer">
          <Button onClick={onClose}>Закрыть</Button>
        </footer>
      )}
    </Dialog>
  );
}
