import type { BrowserObservationSession } from "./browser/session.js";
import type { BrowserScreenshotArtifact, RunDetail, RunEventLevel, RunEventType } from "@cua-sample/contracts";
export type RunExecutionContext = {
  captureScreenshot: (
    session: BrowserObservationSession,
    label: string,
  ) => Promise<BrowserScreenshotArtifact>;
  completeRun: (options: {
    notes: string[];
  }) => Promise<void>;
  detail: RunDetail;
  emitEvent: (input: {
    detail?: string;
    level: RunEventLevel;
    message: string;
    type: RunEventType;
  }) => Promise<void>;
  screenshotDirectory: string;
  signal: AbortSignal;
  syncBrowserState: (
    session: BrowserObservationSession,
  ) => Promise<void>;
};

export interface RunExecutor {
  execute(context: RunExecutionContext): Promise<void>;
}

