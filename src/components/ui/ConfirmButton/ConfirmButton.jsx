import { useEffect, useState } from "react";
import { Button } from "../Button/Button.jsx";

// A changed quote or disabled action requires a new confirmation.
export function ConfirmButton({
  confirmationKey,
  onClick,
  disabled,
  children,
  ...props
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => setArmed(false), [confirmationKey, disabled]);
  return (
    <Button
      {...props}
      disabled={disabled}
      onClick={(event) => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onClick(event);
      }}
    >
      {armed ? <>Подтвердить · {children}</> : children}
    </Button>
  );
}
