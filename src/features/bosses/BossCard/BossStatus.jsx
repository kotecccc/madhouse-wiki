import { editableTargetProps } from "../../../components/ui/EditableTarget/EditableTarget.js";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { Pill } from "../../../components/ui/Pill/Pill.jsx";
import {
  hasUnknownRaidStatusMarker,
  RAID_STATUS_INFO,
} from "../../../lib/raid-schedule.js";

export function BossStatus({
  raid = {},
  status = "unknown",
  availability,
  onSelect,
  size = "sm",
  compact = false,
  ...props
}) {
  let content;
  if (availability !== undefined) {
    content = (
      <Pill
        variant="locked"
        dot={false}
        aria-label="Босс недоступен"
        title="Босс недоступен"
      >
        <Icon type="lock" size="text" />
      </Pill>
    );
  } else {
    const info = RAID_STATUS_INFO[status] || RAID_STATUS_INFO.unknown;
    const hasUnknownMarker =
      status === "unknown" && hasUnknownRaidStatusMarker(raid);
    const label = hasUnknownMarker ? "Маркер не распознан" : info.label;
    content = (
      <Pill
        editKey="status"
        compact={compact}
        variant={info.color}
        title={
          hasUnknownMarker ? "В канале нераспознанный маркер состояния." : label
        }
        aria-label={label}
      >
        {label}
      </Pill>
    );
  }

  const child = content.props.children;
  const handleClick = (event) => {
    if (onSelect) {
      event.stopPropagation();
      onSelect(event);
    }
    props.onClick?.(event);
  };
  const handleKeyDown = (event) => {
    if (onSelect && ["Enter", " "].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      onSelect(event);
    }
    props.onKeyDown?.(event);
  };

  return (
    <Pill
      {...content.props}
      size={size}
      {...(onSelect
        ? { role: "button", tabIndex: 0, "aria-haspopup": "dialog" }
        : {})}
      {...props}
      {...editableTargetProps(
        Boolean(onSelect),
        [content.props.className, props.className].filter(Boolean).join(" "),
      )}
      onClick={onSelect || props.onClick ? handleClick : undefined}
      onKeyDown={onSelect || props.onKeyDown ? handleKeyDown : undefined}
    >
      {child}
    </Pill>
  );
}
