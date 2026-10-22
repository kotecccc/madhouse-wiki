import { useId, useState } from "react";
import { Button } from "../../components/ui/Button/Button.jsx";
import { Input } from "../../components/ui/Input/Input.jsx";
import { FieldLabel } from "../../components/ui/FieldLabel/FieldLabel.jsx";
import { CardDescription } from "../../components/ui/CardDescription/CardDescription.jsx";
import { buildVariantExport } from "./variant-export.js";
import "./VariantExport.css";

export function VariantExport({ editor, entityKey, variant, onChange }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState("");
  const implementation = {
    key:
      variant.implementation?.key ??
      `${entityKey.split(":")[0]}-${variant.id.slice(0, 8)}`,
    usage: variant.implementation?.usage ?? "",
    note: variant.implementation?.note ?? "",
  };
  function update(key, value) {
    setStatus("");
    onChange({ ...implementation, [key]: value });
  }
  function download(format) {
    try {
      const output = buildVariantExport(
        { editor, entityKey, variant, implementation },
        format,
      );
      const url = URL.createObjectURL(
        new Blob([output.content], { type: output.mimeType }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = output.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus(
        `Подготовлен ${output.filename}. Передайте файл в чат для добавления вариации в код.`,
      );
    } catch (error) {
      setStatus(error.message);
    }
  }
  return (
    <div className="variant-export">
      <Button
        size="sm"
        aria-expanded={expanded}
        aria-controls={`${id}-content`}
        onClick={() => setExpanded((value) => !value)}
      >
        Сохранить для кода
      </Button>
      {expanded && (
        <div id={`${id}-content`} className="variant-export">
          <div className="variant-export-field">
            <FieldLabel htmlFor={`${id}-key`}>Имя варианта в коде</FieldLabel>
            <Input
              id={`${id}-key`}
              size="sm"
              value={implementation.key}
              maxLength={64}
              placeholder="boss-compact"
              onChange={(event) => update("key", event.target.value)}
            />
          </div>
          <div className="variant-export-field">
            <FieldLabel htmlFor={`${id}-usage`}>Где использовать</FieldLabel>
            <Input
              id={`${id}-usage`}
              size="sm"
              value={implementation.usage}
              maxLength={1000}
              placeholder="Например: карточки боссов в блоке этажа"
              onChange={(event) => update("usage", event.target.value)}
            />
          </div>
          <div className="variant-export-field">
            <FieldLabel htmlFor={`${id}-note`}>
              Пожелания к реализации
            </FieldLabel>
            <Input
              id={`${id}-note`}
              size="sm"
              value={implementation.note}
              maxLength={2000}
              placeholder="Необязательно"
              onChange={(event) => update("note", event.target.value)}
            />
          </div>
          <div className="variant-export-actions">
            <Button size="sm" onClick={() => download("json")}>
              Скачать JSON
            </Button>
            <Button size="sm" onClick={() => download("md")}>
              Скачать MD
            </Button>
          </div>
          <CardDescription>
            Файл содержит настройки и инструкции для добавления постоянной
            вариации в код.
          </CardDescription>
          {status && <CardDescription role="status">{status}</CardDescription>}
        </div>
      )}
    </div>
  );
}
