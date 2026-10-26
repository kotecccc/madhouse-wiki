import { Icon } from "../Icon/Icon.jsx";
import { CardDescription } from "../CardDescription/CardDescription.jsx";
import "./MutagenLabel.css";

export function MutagenLabel({ mutagen }) {
  if (!mutagen) return null;
  const family = ["I", "A", "F", "X", "S", "Z", "W"].includes(mutagen.type)
    ? mutagen.type
    : "unknown";
  return (
    <span
      className="mutagen-label"
      aria-label={`Установлен: ${mutagen.name}`}
      title={`Установлен: ${mutagen.name}`}
    >
      <span className={`mutagen-label-icon mutagen-label-icon--${family}`}>
        <Icon type="flask" />
      </span>
      <CardDescription size="xs">{mutagen.name}</CardDescription>
    </span>
  );
}
