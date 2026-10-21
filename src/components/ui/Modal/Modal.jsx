import { Dialog } from "../Dialog/Dialog.jsx";
import { Title } from "../Title/Title.jsx";
import { DialogCloseButton } from "../DialogCloseButton/DialogCloseButton.jsx";
import "./Modal.css";

export function Modal({
  title,
  description,
  titleId,
  onClose,
  children,
  className = "",
  width,
  contentScrollable = true,
  contentVariant = "default",
  visible = true,
}) {
  const id = titleId || "modal-title";
  return (
    <Dialog
      modal
      visible={visible}
      surface="modal"
      className={`shared-modal ${className}`.trim()}
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
        <div className="shared-modal-heading-copy">
          <Title as="h2" id={id} className="shared-modal-title">
            {title}
          </Title>
          {description && (
            <p className="shared-modal-description">{description}</p>
          )}
        </div>
        <DialogCloseButton onClick={onClose} />
      </header>
      <div
        className={`shared-modal-content shared-modal-content--${contentVariant}${
          contentScrollable ? "" : " shared-modal-content--unscrollable"
        }`}
      >
        {children}
      </div>
    </Dialog>
  );
}
