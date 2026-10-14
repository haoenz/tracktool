import type { ConfigData } from "../domain/config.js";
import type { TaskEvent } from "../shared/contracts.js";
import type { XmlPort } from "./ports.js";
function freeze(value: unknown): void {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
export interface Context {
  readonly config: ConfigData;
  readonly mode: "plan" | "apply";
  readonly signal: AbortSignal;
  readonly report: (event: TaskEvent) => void;
  readonly xml?: XmlPort;
}
export function createContext(options: {
  config: ConfigData;
  mode?: Context["mode"];
  signal?: AbortSignal;
  report?: Context["report"];
  xml?: XmlPort;
}): Context {
  const config = structuredClone(options.config);
  freeze(config);
  return Object.freeze({
    config,
    mode: options.mode ?? "apply",
    signal: options.signal ?? new AbortController().signal,
    report: options.report ?? (() => {}),
    xml: options.xml,
  });
}
