import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { type BrowserMode, type BrowserViewport } from "@cua-sample/contracts";

export const defaultViewport: BrowserViewport = {
  height: 900,
  width: 1440,
};

export type BrowserSessionState = {
  currentUrl: string;
  pageTitle?: string;
};

export type BrowserScreenshot = BrowserSessionState & {
  capturedAt: string;
  id: string;
  label: string;
  mimeType: "image/png";
  path: string;
};

export type BrowserObservationSession = {
  captureScreenshot: (label: string) => Promise<BrowserScreenshot>;
  close: () => Promise<void>;
  mode: BrowserMode;
  readState: () => Promise<BrowserSessionState>;
  targetLabel: string;
  viewport: BrowserViewport;
};

// Only the worker and browser tests receive these handles.
export type BrowserSession = BrowserObservationSession & {
  browser: Browser;
  context: BrowserContext;
  page: Page;
};


export type BrowserSessionOptions = {
  browserMode: BrowserMode;
  screenshotDir: string;
  url: string;
  targetLabel: string;
};

function sanitizeLabel(label: string) {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "capture";
}

export async function connectBrowserSession(endpoint: string, options: BrowserSessionOptions): Promise<BrowserSession> {
  return createBrowserSession(await chromium.connectOverCDP(endpoint, { timeout: 15_000 }), options);
}

async function createBrowserSession(browser: Browser, options: BrowserSessionOptions): Promise<BrowserSession> {
  const viewport = defaultViewport;
  let context: BrowserContext;
  let page: Page;
  try {
    context = browser.contexts()[0];
    if (!context) throw new Error("Persistent browser context missing.");
    page = context.pages().at(-1) ?? await context.newPage();
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
  let screenshotCount = 0;

  return {
    browser,
    async captureScreenshot(label) {
      screenshotCount += 1;
      await mkdir(options.screenshotDir, { recursive: true });

      const path = join(
        options.screenshotDir,
        `${randomUUID()}-${sanitizeLabel(label)}.png`,
      );
      await page.screenshot({
        path,
      });

      const pageTitle = await page.title();

      return {
        capturedAt: new Date().toISOString(),
        currentUrl: page.url(),
        id: `screenshot-${randomUUID()}`,
        label,
        mimeType: "image/png",
        path,
        ...(pageTitle ? { pageTitle } : {}),
      };
    },
    async close() {
      await browser.close(); // CDP disconnect only; BrowserHost owns the persistent context.
    },
    context,
    mode: options.browserMode,
    get page() {
      if (page.isClosed()) page = context.pages().at(-1) ?? page;
      return page;
    },
    async readState() {
      const pages = context.pages();
      for (const candidate of [...pages].reverse()) {
        if (await candidate.evaluate(() => document.hasFocus()).catch(() => false)) { page = candidate; break; }
      }
      if (page.isClosed()) page = pages.at(-1) ?? await context.newPage();
      const pageTitle = await page.title();

      return {
        currentUrl: page.url(),
        ...(pageTitle ? { pageTitle } : {}),
      };
    },
    targetLabel: options.targetLabel,
    viewport,
  };
}
