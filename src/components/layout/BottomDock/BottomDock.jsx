import "./BottomDock.css";
export function BottomDock({ children, toastRef }) {
  return (
    <div className="bottom-dock">
      <div className="ui-toast-stack" ref={toastRef} />
      {children}
    </div>
  );
}
