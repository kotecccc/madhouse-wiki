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
      disabled={disabled}
      variant={confirming ? "warning" : (props.variant ?? "primary")}
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
