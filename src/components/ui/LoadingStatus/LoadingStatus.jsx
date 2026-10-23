import { CardDescription } from "../CardDescription/CardDescription.jsx";
import "./LoadingStatus.css";

export function LoadingStatus({ children }) {
  return (
    <div className="ui-loading-status" role="status" aria-live="polite">
      <CardDescription as="span" size="md">
        {children}
      </CardDescription>
    </div>
  );
}
