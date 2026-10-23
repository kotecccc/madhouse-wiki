import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import puppeteer from "puppeteer";
import { cataloguePlugin } from "../catalogue/vite-plugin.mjs";
import { bossOpeningGroups } from "./boss-opening-groups.mjs";

export async function renderBossOpeningCards(knowledgeBase, root) {
  const groups = bossOpeningGroups(knowledgeBase);
  if (!groups.length) return [];

  const server = await createServer({
    configFile: false,
    root,
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
    await page.setViewport({ width: 1200, height: 1400, deviceScaleFactor: 2 });
    await page.goto(
      `http://127.0.0.1:${address.port}/scripts/telegram/inline-boss-card-preview.html`,
      { waitUntil: "domcontentloaded", timeout: 60_000 },
    );
    try {
      await page.waitForFunction(
        () => document.documentElement.dataset.bossCardsReady === "true",
        { timeout: 20_000 },
      );
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        ready: document.documentElement.dataset.bossCardsReady,
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
        `Boss card preview did not become ready: ${JSON.stringify({ diagnostics, browserErrors: browserErrors.slice(0, 20) })}`,
        { cause: error },
      );
    }

    const renderedGroups = await page.$$(`[data-boss-opening-group]`);
    if (renderedGroups.length !== groups.length) {
      throw new Error(
        `Rendered ${renderedGroups.length} boss opening groups; expected ${groups.length}`,
      );
    }
    const renderedKeys = await page.$$eval(
      `[data-boss-opening-group]`,
      (elements) => elements.map((element) => element.dataset.bossOpeningGroup),
    );
    if (renderedKeys.some((key, index) => key !== groups[index].key)) {
      throw new Error("Boss opening card groups differ from the SQLite catalogue");
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
