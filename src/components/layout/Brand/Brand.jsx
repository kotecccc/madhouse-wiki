import { useState } from "react";
import changelog from "../../../../changelog.json";
import { Modal } from "../../ui/Modal/Modal.jsx";
import { BaseCard } from "../../ui/BaseCard/BaseCard.jsx";
import { CardTitle } from "../../ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../ui/CardDescription/CardDescription.jsx";
import "./Brand.css";
export function Brand() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <a
        className="brand"
        href="#changelog"
        aria-label="История изменений Madhouse Wiki"
        onClick={(event) => {
          event.preventDefault();
          setOpen(true);
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
