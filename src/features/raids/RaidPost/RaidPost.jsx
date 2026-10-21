import { RaidEventCard } from "../RaidEventCard/RaidEventCard.jsx";
import { sortRaidsByTime } from "../../../lib/raid-schedule.js";
import "./RaidPost.css";

export function RaidPost({ post, archive = false, floorAvailability = {} }) {
  return (
    <section
      className="raid-post"
      aria-label={`Рейды на ${post.raidDateLabel}`}
    >
      {archive && (
        <div className="raid-archive-date">
          <time dateTime={post.raidDate}>{post.raidDateLabel}</time>
          {post.timeZone && <span>Время: {post.timeZone}</span>}
        </div>
      )}
      <ol
        className="raid-event-list"
        aria-label={`Рейды на ${post.raidDateLabel}`}
      >
        {sortRaidsByTime(post.raids).map((raid, index) => (
          <li key={`${post.sourceMessageId}-${raid.time}-${index}`}>
            <RaidEventCard raid={raid} floorAvailability={floorAvailability} />
          </li>
        ))}
      </ol>
    </section>
  );
}
