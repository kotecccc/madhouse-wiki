import { useState } from "react";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";

export function ProgressionGoalButton({ targets }) {
  const [open, setOpen] = useState(false);
  if (!targets.length) return null;
  return (
    <>
      <Button
        variant="card-action"
        accent="gold"
        aria-haspopup="dialog"
        aria-label="Цель открытия"
        title={targets.map((target) => target.text).join("; ")}
        onClick={() => setOpen(true)}
      >
        Цель
      </Button>
      {open && (
        <Modal
          title="Цель открытия"
          onClose={() => setOpen(false)}
          footer={<Button onClick={() => setOpen(false)}>Закрыть</Button>}
        >
          {targets.map((target) => (
            <BaseCard
              key={`${target.destination}-${target.label}`}
              className="floor-goal-details"
            >
              <CardTitle>Для открытия {target.destination}</CardTitle>
              <CardDescription title={target.label}>
                {target.label}
              </CardDescription>
            </BaseCard>
          ))}
        </Modal>
      )}
    </>
  );
}
