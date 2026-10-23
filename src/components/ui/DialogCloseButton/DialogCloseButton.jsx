import { Button } from "../Button/Button.jsx";
import { Icon } from "../Icon/Icon.jsx";
import "./DialogCloseButton.css";

export function DialogCloseButton({ onClick, className = "", ...props }) {
  return (
    <Button
      variant="secondary"
      className={`dialog-close-button ${className}`.trim()}
      aria-label="Закрыть"
      onClick={onClick}
      {...props}
    >
      <Icon type="close" size="small" />
    </Button>
  );
}
