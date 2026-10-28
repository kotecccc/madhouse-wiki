import { useEffect, useRef, useState } from "react";
import changelog from "../../../../changelog.json";
import { Modal } from "../../ui/Modal/Modal.jsx";
import { BaseCard } from "../../ui/BaseCard/BaseCard.jsx";
import { CardTitle } from "../../ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../ui/CardDescription/CardDescription.jsx";
import "./Brand.css";
export function Brand({ onHome }) {
  const [open, setOpen] = useState(false);
  const press = useRef(null);
  const suppressClick = useRef(false);
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => () => cancelPress(), []);
  return (
    <>
      <a
        className="brand"
        href="/"
        aria-label="Главная Madhouse Wiki. Shift+Enter — история изменений"
        title="Главная. Удерживайте для истории изменений"
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          cancelPress();
          suppressClick.current = false;
          const { clientX, clientY, pointerId } = event;
          const timer = setTimeout(() => {
            press.current = null;
            suppressClick.current = true;
            setOpen(true);
          }, 600);
          press.current = { timer, clientX, clientY, pointerId };
        }}
        onPointerMove={(event) => {
          const start = press.current;
          if (
            start &&
            start.pointerId === event.pointerId &&
            Math.hypot(
              event.clientX - start.clientX,
              event.clientY - start.clientY,
            ) > 10
          )
            cancelPress();
        }}
        onPointerUp={cancelPress}
        onPointerCancel={() => {
          cancelPress();
          suppressClick.current = false;
        }}
        onContextMenu={(event) => {
          if (press.current || suppressClick.current) event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.shiftKey) {
            event.preventDefault();
            cancelPress();
            setOpen(true);
          }
        }}
        onClick={(event) => {
          if (suppressClick.current) {
            event.preventDefault();
            suppressClick.current = false;
          } else if (
            onHome &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey &&
            event.button === 0
          ) {
            event.preventDefault();
            onHome();
          }
        }}
      >
        <img
          className="brand-mark"
          src="/madhouse-wiki-bot-avatar.png"
          alt=""
          aria-hidden="true"
        />
        <span className="brand-name">
          MADHOUSE <b>WIKI</b>
        </span>
      </a>
      {open && (
        <Modal title="История изменений" onClose={() => setOpen(false)}>
          {changelog.map((release) => (
            <BaseCard key={release.version} className="brand-changelog-release">
              <CardTitle>
                v{release.version} ·{" "}
                {release.date.split("-").reverse().join(".")}
              </CardTitle>
              {release.changes.map((change) => (
                <CardDescription key={change}>{change}</CardDescription>
              ))}
            </BaseCard>
          ))}
        </Modal>
      )}
    </>
  );
}
