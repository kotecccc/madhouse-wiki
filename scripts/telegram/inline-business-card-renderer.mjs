import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import puppeteer from "puppeteer";
import { tmpdir } from "node:os";
import { cataloguePlugin } from "../catalogue/vite-plugin.mjs";
import { businessCardFilename } from "./inline-card-assets.mjs";
import { businessUpgradeCardGroups } from "./inline-business-card-groups.mjs";

export async function renderBusinessUpgradeCards(knowledgeBase, root) {
  const groups = businessUpgradeCardGroups(knowledgeBase).map((group) => ({
    ...group,
    filename: businessCardFilename(
      group.businessId,
      group.requirement.requiredLevel,
    ),
  }));
  if (!groups.length) return [];

  const server = await createServer({
    configFile: false,
    root,
    cacheDir: `${tmpdir()}/madhouse-vite-cache-${process.pid}`,
    plugins: [react(), cataloguePlugin(root)],
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      open: false,
    },
    appType: "mpa",
    clearScreen: false,
    logLevel: "error",
    optimizeDeps: {
      noDiscovery: true,
      include: ["react", "react-dom/client"],
    },
  });

  let browser;
  try {
    await server.listen();
    const address = server.httpServer.address();
    if (!address || typeof address === "string")
      throw new Error("Could not resolve the inline-card preview server port");

    const launchOptions = {
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    page.on("requestfailed", (request) => {
      browserErrors.push(`${request.url()}: ${request.failure()?.errorText}`);
    });
    await page.setViewport({ width: 760, height: 1400, deviceScaleFactor: 2 });
    await page.goto(
      `http://127.0.0.1:${address.port}/scripts/telegram/inline-business-card-preview.html`,
      { waitUntil: "domcontentloaded", timeout: 60_000 },
    );
    try {
      await page.waitForFunction(
        () => document.documentElement.dataset.businessCardsReady === "true",
        { timeout: 20_000 },
      );
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        ready: document.documentElement.dataset.businessCardsReady,
        title: document.title,
        rootChildren: document.getElementById("root")?.childElementCount,
        fontStatus: document.fonts?.status,
        images: Array.from(document.images, (image) => ({
          complete: image.complete,
          width: image.naturalWidth,
          url: image.currentSrc,
        })),
      }));
      throw new Error(
        `Business card preview did not become ready: ${JSON.stringify({ diagnostics, browserErrors: browserErrors.slice(0, 20) })}`,
        { cause: error },
      );
    }

    const renderedGroups = await page.$$(`[data-business-upgrade-group]`);
    if (renderedGroups.length !== groups.length) {
      throw new Error(
        `Rendered ${renderedGroups.length} business upgrade groups; expected ${groups.length}`,
      );
    }
    const renderedKeys = await page.$$eval(
      `[data-business-upgrade-group]`,
      (elements) =>
        elements.map((element) => element.dataset.businessUpgradeGroup),
    );
    if (renderedKeys.some((key, index) => key !== groups[index].key)) {
      throw new Error("Business card groups differ from the SQLite catalogue");
    }
    const { default: sharp } = await import("sharp");
    const results = [];
    for (let index = 0; index < groups.length; index += 1) {
      const screenshot = await renderedGroups[index].screenshot({
        type: "png",
        captureBeyondViewport: true,
      });
      results.push({
        filename: groups[index].filename,
        buffer: await sharp(screenshot)
          .jpeg({
            quality: 95,
            mozjpeg: true,
            chromaSubsampling: "4:4:4",
            progressive: true,
          })
          .toBuffer(),
      });
    }
    return results;
  } finally {
    await browser?.close();
    await server.close();
  }
}
