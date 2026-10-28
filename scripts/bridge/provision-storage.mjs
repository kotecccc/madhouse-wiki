import { createBridgeStorage } from "./device-storage.mjs";

// Run once against new, empty volumes before enabling the bridge services.
// createBridgeStorage refuses to provision over an existing registry or witness.
const storage = createBridgeStorage({
  directory: process.env.MADHOUSE_BRIDGE_STATE_DIR,
  witnessPath: process.env.MADHOUSE_BRIDGE_WITNESS_PATH,
  provisionWitness: true,
});
storage.close();
console.log("Bridge storage provisioned.");
