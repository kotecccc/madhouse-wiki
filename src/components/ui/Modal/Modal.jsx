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
  footer,
  className = "",
  width,
  showCloseButton = true,
  contentScrollable = true,
  contentVariant = "default",
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
      className={`shared-modal ${className}`.trim()}
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
        }${contentScrollable ? "" : " shared-modal-content--unscrollable"}`}
      >
        {children}
      </div>
      {footer ? (
        <footer className="shared-modal-footer">{footer}</footer>
      ) : (
        <footer className="shared-modal-footer shared-modal-mobile-footer">
          <Button onClick={onClose}>Закрыть</Button>
        </footer>
      )}
    </Dialog>
  );
}
