import { useState } from "react";
import { Toast } from "../Toast/Toast.jsx";

function ErrorToastMessage({ message, children }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <Toast
      floating
      urgent
      action={children}
      onDismiss={() => setDismissed(true)}
    >
      {message}
    </Toast>
  );
}

export function ErrorToast({ message, children }) {
  return message ? (
    <ErrorToastMessage key={message} message={message}>
      {children}
    </ErrorToastMessage>
  ) : null;
}
