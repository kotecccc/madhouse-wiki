import { knowledgeBase } from "virtual:madhouse-catalogue";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { Title } from "../../../components/ui/Title/Title.jsx";
import {
  CardEditScope,
  useCardEditing,
} from "../../../components/ui/CardEditing/CardEditing.jsx";
import { EditableLayout } from "../../../components/ui/CardEditing/EditableLayout.jsx";
import {
  getDepartmentBosses,
  getDepartmentBusinesses,
  getBusinessUpgrade,
} from "../../../model/knowledge-base.js";
import { WorkCard } from "../../works/WorkCard/WorkCard.jsx";
import { BusinessEntityCard } from "../../businesses/BusinessEntityCard/BusinessEntityCard.jsx";
import { DepartmentBossCard } from "../../bosses/DepartmentBossCard/DepartmentBossCard.jsx";
import { OpeningConditionCard } from "../OpeningConditionCard/OpeningConditionCard.jsx";
import "./BlockCard.css";

import {
  BLOCK_SECTIONS,
  BLOCK_SECTION_LABELS,
} from "../../../lib/block-sections.js";

function BlockContent({ department, onTargetSelect }) {
  const editing = useCardEditing("sections", "block", {
    sectionOrder: BLOCK_SECTIONS,
    hiddenSections: [],
  });
  const works = knowledgeBase.works.filter(
    (work) => work.departmentId === department.id,
  );
  const bosses = getDepartmentBosses(department.id);
  const businesses = getDepartmentBusinesses(department.id);
  const conditions = department.openingConditions || [];
  const sections = {
    requirements: conditions.map((requirement, index) => (
      <li key={requirement.id || index}>
        <OpeningConditionCard
          requirement={requirement}
          department={department}
          mode="detailed"
          onTargetSelect={onTargetSelect}
        />
      </li>
    )),
    works: works.map((work) => (
      <li key={work.id}>
        <WorkCard work={work} department={department} preset="work-main" />
      </li>
    )),
    bosses: bosses.map((boss) => (
      <DepartmentBossCard key={boss.id} boss={boss} />
    )),
    businesses: businesses.map((business) => (
      <li key={business.id}>
        <BusinessEntityCard
          business={business}
          upgrade={getBusinessUpgrade(business.id)}
        />
      </li>
    )),
  };
  const fields = [
    { id: "code", label: "Код блока", value: department.code || "" },
    { id: "name", label: "Название", value: department.name || "" },
    { id: "work", label: "Работа", value: department.work?.title || "" },
    { id: "stash", label: "Набор", value: department.work?.stash || "" },
  ];
  return (
    <BaseCard as="details" editKey="card" className="block-card" open>
      <summary className="block-card-summary">
        <div className="block-card-copy">
          <CardTitle
            editKey="title"
            composition={{ fields, defaultFields: ["code", "name"] }}
          >
            {[department.code, department.name].filter(Boolean).join(" • ")}
          </CardTitle>
          <CardDescription
            editKey="description"
            composition={{ fields, defaultFields: ["work", "stash"] }}
          >
            {[department.work?.title, department.work?.stash]
              .filter(Boolean)
              .join(" • ") || "Содержимое блока"}
          </CardDescription>
        </div>
        {editing.editable && (
          <Button
            size="sm"
            variant="secondary"
            {...editing.targetProps}
            className={editing.className}
            aria-label="Настроить состав блока"
          >
            Секции
          </Button>
        )}
        <Icon type="chevron" size="small" />
      </summary>
      <EditableLayout editKey="content-layout" className="block-card-sections">
        {department.note && (
          <CardDescription editKey="note">{department.note}</CardDescription>
        )}
        {(editing.values.sectionOrder || BLOCK_SECTIONS)
          .filter(
            (key) =>
              BLOCK_SECTIONS.includes(key) &&
              !editing.values.hiddenSections?.includes(key),
          )
          .map((key) => (
            <section key={key} className="block-card-section">
              <Title as="h4" editKey={`heading-${key}`}>
                {BLOCK_SECTION_LABELS[key]}
              </Title>
              <ul className="block-card-list">
                {sections[key].length ? (
                  sections[key]
                ) : (
                  <li>
                    <CardDescription>Данные не указаны</CardDescription>
                  </li>
                )}
              </ul>
            </section>
          ))}
      </EditableLayout>
    </BaseCard>
  );
}

export function BlockCard(props) {
  return (
    <CardEditScope scope={`block:${props.department.id}`}>
      <BlockContent {...props} />
    </CardEditScope>
  );
}
