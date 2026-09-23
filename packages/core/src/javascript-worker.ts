import vm from "node:vm";
import util from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { connectBrowserSession, type BrowserScreenshot, type BrowserSession } from "./browser/session.js";
import { isRecord, maxCodeBytes, maxOutputBytes, parseJavaScriptOutput, type JavaScriptOutput, type WorkerOperation } from "./browser/protocol.js";
import { createDesktopAPI, createPlatformDriver, type DesktopAPI, type DesktopScreenshot } from "./desktop/index.js";

let session: BrowserSession | undefined;
let repl: vm.Context | undefined;
let outputs: JavaScriptOutput[] = [];
let outputBytes = 0;
let busy = false;
let closing = false;
// 桌面层：只在 initialize 明确开启时创建；一旦模型用过 desktop，后续存档截图改为桌面截图。
let desktop: (DesktopAPI & {capture(): Promise<DesktopScreenshot>}) | undefined;
let desktopUsed = false;
let screenshotDir = "";

async function saveDesktopScreenshot(shot: DesktopScreenshot, label: string): Promise<BrowserScreenshot> {
  await mkdir(screenshotDir, { recursive: true });
  const path = join(screenshotDir, `${randomUUID()}-desktop-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 64) || "capture"}.png`);
  await writeFile(path, shot.png);
  return { capturedAt: new Date().toISOString(), currentUrl: "desktop://main-display", id: `screenshot-${randomUUID()}`, label, mimeType: "image/png", path,
    ...(shot.frontmostApp ? { pageTitle: shot.frontmostApp } : {}) };
}

function createDesktop() {
  const api = createDesktopAPI(createPlatformDriver(), shot => {
    // 模型调用 desktop.screenshot() 时回显图片；存档由 capture 操作负责，避免每次都写盘两份。
    appendOutput({ type: "input_image", image_url: `data:image/png;base64,${shot.png.toString("base64")}`, detail: "original" });
  });
  // 代理一层：记录“桌面已被使用”，并且保证抛出的都是普通 Error 文案。
  return new Proxy(api, {
    get(target, property: keyof typeof api) {
      const value = target[property];
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => { desktopUsed = true; return (value as (...a: unknown[]) => unknown).apply(target, args); };
    },
  });
}

function appendOutput(output: JavaScriptOutput) {
  outputBytes += Buffer.byteLength(JSON.stringify(output));
  if (outputBytes > maxOutputBytes - 1024) throw new Error("JavaScript output exceeds 12 MiB.");
  outputs.push(output);
}

function createRepl(browserSession: BrowserSession) {
  return vm.createContext({
    ...(desktop ? { desktop } : {}),
    browser: browserSession.browser,
    context: browserSession.context,
    get page() { return browserSession.page; },
    Buffer,
    setTimeout, clearTimeout,
    sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.min(Math.max(0, Number(ms) || 0), 30_000))),
    console: {
      log: (...values: unknown[]) => appendOutput({
        type: "input_text",
        text: util.formatWithOptions({ getters: false, maxStringLength: 2_000, showHidden: false }, ...values),
      }),
    },
    display: (image: string) => {
      if (typeof image !== "string") throw new Error("display expects a base64 image string.");
      appendOutput({
        type: "input_image",
        image_url: image.startsWith("data:image/") ? image : `data:image/png;base64,${image}`,
        detail: "original",
      });
    },
  });
}

async function execute(code: string) {
  if (typeof code !== "string" || !code.trim() || Buffer.byteLength(code) > maxCodeBytes) {
    throw new Error("JavaScript code must be nonempty and at most 64 KiB.");
  }
  outputs = [];
  outputBytes = 0;
  try {
    // The parent process enforces the deadline, including loops after an await.
    await new vm.Script(`(async () => {\n${code}\n})();`, { filename: "exec_js.js" }).runInContext(repl!);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (outputBytes > maxOutputBytes - 1024) throw new Error("JavaScript output exceeds 12 MiB.");
    appendOutput({ type: "input_text", text: message.slice(0, 4_000) });
  }
  if (!outputs.length) appendOutput({ type: "input_text", text: "exec_js completed with no console output." });
  return parseJavaScriptOutput(outputs);
}

async function handle(operation: WorkerOperation) {
  if (operation.operation === "initialize") {
    if (session ||
      ![operation.endpoint, operation.url, operation.screenshotDir, operation.targetLabel]
        .every(value => typeof value === "string") ||
      !["headless", "headful"].includes(operation.browserMode)) {
      throw new Error("Invalid worker initialization.");
    }
    session = await connectBrowserSession(operation.endpoint, {
      browserMode: operation.browserMode,
      screenshotDir: operation.screenshotDir,
      url: operation.url,
      targetLabel: operation.targetLabel,
    });
    session.context.setDefaultTimeout(10_000);
    session.context.setDefaultNavigationTimeout(15_000);
    screenshotDir = operation.screenshotDir;
    if (operation.desktop === true) desktop = createDesktop();
    repl = createRepl(session);
    return session.readState();
  }
  if (!session || !repl) throw new Error("JavaScript worker has not initialized.");
  switch (operation.operation) {
    case "execute":
      return execute(operation.code);
    case "inspect":
      return session.readState();
    case "capture":
      if (typeof operation.label !== "string") throw new Error("Invalid screenshot label.");
      if (desktop && desktopUsed) {
        // 存档截图不回显给模型：临时关闭回调输出（capture 期间没有 exec 在跑，outputs 会在下次 execute 前清空）。
        const shot = await desktop.capture().catch(() => undefined);
        outputs = []; outputBytes = 0;
        if (shot) return saveDesktopScreenshot(shot, operation.label);
      }
      return session.captureScreenshot(operation.label);
    default:
      throw new Error("Unknown JavaScript worker operation.");
  }
}

async function close() {
  if (closing) return;
  closing = true;
  try {
    await session?.close();
  } finally {
    process.exit(0);
  }
}

process.on("disconnect", () => {
  void close();
});
process.on("message", (message: unknown) => {
  if (closing) return;
  if (isRecord(message) && message.operation === "close") {
    void close();
    return;
  }
  if (!isRecord(message) || !Number.isSafeInteger(message.id) || busy) {
    process.send?.({ id: isRecord(message) ? message.id : null, error: "Invalid or concurrent JavaScript worker request." });
    return;
  }
  busy = true;
  void handle(message as WorkerOperation).then(
    result => {
      if (!closing) process.send?.({ id: message.id, result });
    },
    error => {
      if (!closing) process.send?.({
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  ).finally(() => {
    busy = false;
  });
});
