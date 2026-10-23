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
import { Title } from "../../../components/ui/Title/Title.jsx";
import { LockIndicator } from "../LockIndicator/LockIndicator.jsx";
import { trackProductEvent } from "../../analytics/analytics-client.js";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { CardEditScope } from "../../../components/ui/CardEditing/CardEditing.jsx";
import { EditableValue } from "../../../components/ui/CardEditing/EditableValue.jsx";
import { EditableLayout } from "../../../components/ui/CardEditing/EditableLayout.jsx";

const showDepartmentBusinesses = false;

export function FloorWorkItem({
  work,
  onCalculator,
  onUpgradeSelect,
  onRequirementSelect,
  focused,
  registerDepartment,
  suppressRequirements = false,
  locked = false,
}) {
  const deptBosses = getDepartmentBosses(work.id);
  const businesses = getDepartmentBusinesses(work.id);
  const upgrades = getDepartmentUpgrades(work.id);
  const requirements = (work.openingConditions || []).filter(
    (r) =>
      !suppressRequirements &&
      !(work.code === "A1" && r.type === "player_level" && r.required === 0),
  );
  const fields = [
    { id: "block", label: "Блок этажа", value: work.code },
    { id: "name", label: "Название отделения", value: work.name || "" },
    { id: "work", label: "Работёнка", value: work.work?.title || "" },
    { id: "stash", label: "Тайник", value: work.work?.stash || "" },
    {
      id: "energy",
      label: "Энергия",
      value:
        work.energyCycle?.full == null
          ? ""
          : `Энергия ${fmt(work.energyCycle.full)}`,
    },
  ];
  return (
    <CardEditScope scope={`department:${work.id}`}>
      <li
        className="floor-work"
        ref={(node) =>
          registerDepartment?.(work.id, node?.querySelector("details"))
        }
      >
        <details
          className="floor-work-disclosure"
          open={focused || undefined}
          onToggle={(event) => {
            if (event.currentTarget.open)
              trackProductEvent("department_open", {
                section: "floors",
                feature: "work_details",
                subject: work.code,
              });
          }}
        >
          <summary className="floor-work-summary">
            <ImageCard
              editKey="image"
              className="image-card--work"
              size="var(--work-image-card-size)"
              imageSize="var(--work-image-size)"
              src={work.work?.image}
              label={work.work?.stash || "Отделение"}
              title={work.work?.stash || "Отделение"}
            >
              {!work.work?.image && <span>{work.code}</span>}
            </ImageCard>
            <div className="floor-work-details">
              <div className="floor-work-copy">
                <div className="floor-work-title">
                  <CardTitle
                    composition={{ fields, defaultFields: ["block", "name"] }}
                    editKey="title"
                  >
                    <span className="floor-work-code">
                      {locked && <LockIndicator size="medium" />}
                      <EditableValue
                        editKey="code"
                        className="floor-work-id"
                        lang="en"
                      >
                        {work.code}
                      </EditableValue>
                    </span>
                    {work.name && (
                      <>
                        {" "}
                        •{" "}
                        <EditableValue editKey="name">
                          {work.name}
                        </EditableValue>
                      </>
                    )}
                  </CardTitle>
                </div>
                <CardDescription
                  composition={{ fields, defaultFields: ["work", "stash"] }}
                  editKey="description"
                  className="floor-work-description"
                >
                  {[work.work?.title, work.work?.stash]
                    .filter(Boolean)
                    .join(" • ")}
                </CardDescription>
              </div>
            </div>
            <span className="floor-cost">
              <EditableValue editKey="cost">
                {work.energyCycle?.full == null
                  ? "—"
                  : fmt(work.energyCycle.full)}
              </EditableValue>{" "}
              <Icon type="energy" size="medium" />
            </span>
          </summary>
          <EditableLayout
            editKey="content-layout"
            paddingDefault="16"
            gapDefault="16"
            className="floor-work-expanded"
          >
            {requirements.length > 0 && (
              <section className="floor-work-extra floor-work-requirements">
                <Title as="h4" editKey="requirements-heading">
                  Условие открытия
                </Title>
                <ul className="floor-work-requirement-list">
                  {requirements.map((r, i) => (
                    <RequirementCard
                      key={`${work.id}-${i}`}
                      requirement={r}
                      work={work}
                      onCalculator={onCalculator}
                      onTargetSelect={onRequirementSelect}
                    />
                  ))}
                </ul>
              </section>
            )}
            <section className="floor-work-extra floor-work-bosses">
              <Title as="h4" editKey="bosses-heading">
                Боссы
              </Title>
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
            {showDepartmentBusinesses && (
              <section className="floor-work-extra">
                <Title as="h4" editKey="businesses-heading">
                  Бизнесы
                </Title>
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
            )}
          </EditableLayout>
        </details>
      </li>
    </CardEditScope>
  );
}
