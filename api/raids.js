import { createRaidVercelHandler } from "../scripts/telegram/raid-vercel-handler.mjs";
import { raidApi } from "../scripts/telegram/raid-api.mjs";

export default createRaidVercelHandler(raidApi);
