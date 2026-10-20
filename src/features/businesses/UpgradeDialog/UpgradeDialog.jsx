import "./UpgradeDialog.css";
import { BusinessItemTile } from "../BusinessItemTile/BusinessItemTile.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { getDepartmentBosses } from "../../../model/knowledge-base.js";
import { Dialog } from "../../../components/ui/Dialog/Dialog.jsx";
import { fmt } from "../../../lib/format.js";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Title } from "../../../components/ui/Title/Title.jsx";
export function UpgradeDialog({ data, onClose }) {
  const { business, upgrade } = data;
  const departmentBosses = getDepartmentBosses(business.departmentId);
  const levels = Math.max(
    0,
    ...(upgrade?.items || []).map((i) => i.levels.length),
  );
  return (
    <Dialog
      className="business-upgrade-dialog"
      onClose={onClose}
      aria-labelledby="upgrade-title"
    >
      <section className="business-upgrade-dialog-panel">
        <Button
          className="business-upgrade-dialog-close"
          onClick={onClose}
          aria-label="Закрыть"
        >
          ×
        </Button>
        <Title as="h2" id="upgrade-title">{business.title || "Бизнес"}</Title>
        {upgrade && (
          <div className="business-upgrade-level-grid">
            {Array.from({ length: levels }, (_, n) => (
              <BaseCard
                as="section"
                variant="upgrade-level"
                className="business-upgrade-level-card"
                key={n}
              >
                <div className="business-upgrade-level-heading">
                  <span>УРОВЕНЬ {String(n + 1).padStart(2, "0")}</span>
                  <strong>{n + 1}</strong>
                </div>
                <div className="business-upgrade-level-items">
                  {upgrade.items.map((item, i) => (
                    <BaseCard
                      as="div"
                      className="business-upgrade-item-card"
                      key={item.name}
                    >
                      <ImageCard
                        src={departmentBosses[i]?.image || ""}
                        alt=""
                      />
                      <div className="business-upgrade-item-details">
                        <CardTitle>
                          {departmentBosses[i]?.name || "Босс не указан"}
                        </CardTitle>
                        <CardDescription>{item.name}</CardDescription>
                      </div>
                      <BusinessItemTile
                        itemId={departmentBosses[i]?.dropItemId}
                        labelled={false}
                      />
                      <strong className="business-upgrade-item-count">
                        {item.levels[n] == null ? "—" : fmt(item.levels[n])}
                      </strong>
                    </BaseCard>
                  ))}
                </div>
              </BaseCard>
            ))}
          </div>
        )}
      </section>
    </Dialog>
  );
}
