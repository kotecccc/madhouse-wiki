import { useEffect, useState } from "react";
import { Button } from "../Button/Button.jsx";

// A changed quote or disabled action requires a new confirmation.
export function ApprovableButton({
  confirmationKey,
  onClick,
  disabled,
  children,
  confirmationLabel,
  approved,
  onArm,
  ...props
}) {
  const [armedKey, setArmedKey] = useState(null);
  useEffect(() => {
    if (disabled) setArmedKey(null);
  }, [disabled]);
  const confirming =
    approved ?? (armedKey !== null && armedKey === confirmationKey);
  return (
    <Button
      {...props}
      menuValue={
        confirming && props.variant === "menu-item" ? null : props.menuValue
      }
      disabled={disabled}
      variant={
        confirming && props.variant !== "menu-item"
          ? "warning"
          : (props.variant ?? "primary")
      }
      tone={
        confirming && props.variant === "menu-item" ? "warning" : props.tone
      }
      onClick={(event) => {
        if (!confirming) {
          if (onArm) onArm(event);
          else setArmedKey(confirmationKey);
          return;
        }
        setArmedKey(null);
        onClick(event);
      }}
    >
      {confirming ? (confirmationLabel ?? <>Точно? · {children}</>) : children}
    </Button>
  );
}
