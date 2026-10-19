import metadata from "./metadata.json" with { type: "json" };
import sources from "./sources.json" with { type: "json" };
import assets from "./assets.json" with { type: "json" };
import floors from "./floors.json" with { type: "json" };
import departments from "./departments.json" with { type: "json" };
import bosses from "./bosses.json" with { type: "json" };
import businesses from "./businesses.json" with { type: "json" };
import businessUpgrades from "./business-upgrades.json" with { type: "json" };

export const knowledgeBase = {
  ...metadata,
  sources,
  assets,
  floors,
  departments,
  bosses,
  businesses,
  businessUpgrades,
};
export default knowledgeBase;
