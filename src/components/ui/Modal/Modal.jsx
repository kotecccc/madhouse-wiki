import { Dialog } from "../Dialog/Dialog.jsx";
import { Title } from "../Title/Title.jsx";
import { Button } from "../Button/Button.jsx";
import "./Modal.css";

export function Modal({
  title,
  titleId,
  onClose,
  children,
  className = "",
  width,
  footer,
  contentBackground,
  contentScrollable = true,
  compact = false,
  dense = false,
  visible = true,
}) {
  const id = titleId || "modal-title";
  return (
    <Dialog
      modal
      visible={visible}
      surface="modal"
      className={`shared-modal${compact ? " shared-modal--compact" : ""}${dense ? " shared-modal--dense" : ""} ${className}`.trim()}
      aria-labelledby={id}
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
        <Title as="h2" id={id} className="shared-modal-title">
          {title}
        </Title>
        <Button
          variant="secondary"
          className="shared-modal-close"
          aria-label="Закрыть"
          onClick={onClose}
        >
          ×
        </Button>
      </header>
      <div
        className={`shared-modal-content${
          contentBackground === "deep" ? " shared-modal-content--deep" : ""
        }${contentScrollable ? "" : " shared-modal-content--unscrollable"}`}
      >
        {children}
      </div>
      {footer != null && (
        <footer className="shared-modal-footer">{footer}</footer>
      )}
    </Dialog>
  );
}
