import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { connectTcp } from "@fuman/node";
import { BaseTelegramClient, TelegramClient } from "@mtcute/core/client.js";
import { IntermediatePacketCodec, MemoryStorage } from "@mtcute/core";
import { WebCryptoProvider } from "@mtcute/web";
import { SIMD_AVAILABLE } from "@mtcute/wasm";

class TcpTransport {
  async connect(dc, abortSignal) {
    const connection = await connectTcp(
      { address: dc.ipAddress, port: dc.port },
      abortSignal,
    );
    connection.setNoDelay(true);
    connection.setKeepAlive(true);
    return connection;
  }

  packetCodec() {
    return new IntermediatePacketCodec();
  }
}

const serverPlatform = {
  beforeExit: () => () => {},
  log: () => {},
  getDefaultLogLevel: () => 0,
  getDeviceModel: () =>
    `Madhouse Wiki raid importer / Node.js ${process.version}`,
};

async function wasmBinary() {
  const filename = SIMD_AVAILABLE ? "mtcute-simd.wasm" : "mtcute.wasm";
  const candidates = [
    resolve(process.cwd(), "node_modules/@mtcute/wasm", filename),
    new URL(`../../node_modules/@mtcute/wasm/${filename}`, import.meta.url),
  ];
  for (const path of candidates) {
    try {
      return new WebAssembly.Module(await readFile(path));
    } catch {
      // Try the source checkout path after the Vercel function-local package path.
    }
  }
  throw new Error("raid_mtproto_runtime_unavailable");
}

export async function createRaidTelegramClient({
  apiId = process.env.TELEGRAM_API_ID,
  apiHash = process.env.TELEGRAM_API_HASH,
  disableUpdates = true,
  updates,
} = {}) {
  const parsedApiId = Number(apiId);
  if (
    !Number.isSafeInteger(parsedApiId) ||
    parsedApiId <= 0 ||
    typeof apiHash !== "string" ||
    !/^[a-f0-9]{32}$/i.test(apiHash)
  )
    throw new Error("raid_mtproto_config_unavailable");

  const baseClient = new BaseTelegramClient({
    apiId: parsedApiId,
    apiHash,
    storage: new MemoryStorage(),
    crypto: new WebCryptoProvider({ wasmInput: await wasmBinary() }),
    transport: new TcpTransport(),
    platform: serverPlatform,
    logLevel: 0,
    disableUpdates,
    initConnectionOptions: {
      deviceModel: "Madhouse Wiki raid importer",
      appVersion: "1.0.0",
      systemVersion: `Node.js/${process.version}`,
    },
  });
  return new TelegramClient({ client: baseClient, disableUpdates, updates });
}
