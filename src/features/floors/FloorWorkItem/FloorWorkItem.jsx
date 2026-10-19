import "./FloorWorkItem.css";
import { BusinessCard } from "../../businesses/BusinessCard/BusinessCard.jsx";
import { DepartmentBossCard } from "../../bosses/DepartmentBossCard/DepartmentBossCard.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import {
  getDepartmentBosses,
  getDepartmentBusinesses,
  getDepartmentUpgrades,
} from "../../../model/knowledge-base.js";
import { fmt } from "../../../lib/format.js";
import { RequirementCard } from "../RequirementCard/RequirementCard.jsx";
import { UpgradeTable } from "../../businesses/UpgradeTable/UpgradeTable.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
export function FloorWorkItem({ work, onCalculator, onUpgradeSelect }) {
  const deptBosses = getDepartmentBosses(work.id);
  const businesses = getDepartmentBusinesses(work.id);
  const upgrades = getDepartmentUpgrades(work.id);
  const requirements = (work.openingConditions || []).filter(
    (r) =>
      !(work.code === "A1" && r.type === "player_level" && r.required === 0),
  );
  return (
    <li className="floor-work">
      <details className="floor-work-disclosure">
        <summary className="floor-work-summary">
          <ImageCard
            className="image-card--work"
            size="var(--work-image-card-size)"
            imageSize="var(--work-image-size)"
            src={work.work?.image}
            label={work.work?.stash || "Набор"}
            title={work.work?.stash || "Набор"}
          />
          <div className="floor-work-details">
            <div className="floor-work-copy">
              <CardTitle>
                <span className="floor-work-id" lang="en">
                  {work.code}
                </span>
                {work.name && (
                  <>
                    {" "}
                    · <span>{work.name}</span>
                  </>
                )}
              </CardTitle>
              <CardDescription className="floor-work-description">
                {[work.work?.title, work.work?.stash]
                  .filter(Boolean)
                  .join(" · ")}
              </CardDescription>
            </div>
          </div>
          <span className="floor-cost">
            {work.energyCycle?.full == null
              ? "— ⚡"
              : `${fmt(work.energyCycle.full)} ⚡`}
          </span>
        </summary>
        <div className="floor-work-expanded">
          {requirements.length > 0 && (
            <section className="floor-work-extra floor-work-requirements">
              <h4>Условие открытия</h4>
              <ul className="floor-work-requirement-list">
                {requirements.map((r, i) => (
                  <RequirementCard
                    key={`${work.id}-${i}`}
                    requirement={r}
                    work={work}
                    onCalculator={onCalculator}
                  />
                ))}
              </ul>
            </section>
          )}
          <section className="floor-work-extra floor-work-bosses">
            <h4>Боссы</h4>
            {deptBosses.length ? (
              <ul className="floor-work-boss-list">
                {deptBosses.map((boss) => (
                  <DepartmentBossCard key={boss.id} boss={boss} />
                ))}
              </ul>
            ) : (
              <p className="floor-work-empty">
                Боссы для этого блока в бестиарии не указаны.
              </p>
            )}
          </section>
          <section className="floor-work-extra">
            <h4>Бизнесы</h4>
            {businesses.length ? (
              <ul className="floor-work-business-list">
                {businesses.map((business) => (
                  <BusinessCard
                    key={business.id}
                    business={business}
                    upgrade={upgrades.find(
                      (upgrade) => upgrade.businessId === business.id,
                    )}
                    onUpgradeSelect={onUpgradeSelect}
                  />
                ))}
              </ul>
            ) : (
              <p className="floor-work-empty">
                В данных нет бизнесов для этого блока.
              </p>
            )}
            {upgrades
              .filter((u) => u.businessId == null)
              .map((u) => (
                <UpgradeTable key={u.id} upgrade={u} />
              ))}
          </section>
        </div>
      </details>
    </li>
  );
}
