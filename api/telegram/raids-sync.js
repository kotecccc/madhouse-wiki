import { createRaidVercelHandler } from "../../scripts/telegram/raid-vercel-handler.mjs";
import { raidSyncApi } from "../../scripts/telegram/raid-sync-api.mjs";

export default createRaidVercelHandler(raidSyncApi);
