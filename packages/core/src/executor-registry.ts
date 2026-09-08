import type { RunDetail } from "@cua-sample/contracts";
import type { RunExecutor } from "./scenario-runtime.js";
export function createDefaultRunExecutor(_detail: RunDetail): RunExecutor { throw new Error("Desktop executor must be configured."); }
