import { publicConfig } from "../domain/config.js";
import { checkCancelled } from "../domain/errors.js";
import type { Context } from "./context.js";
export function getPublicConfig(context: Context, envKey?: string) {
  checkCancelled(context.signal);
  return publicConfig(context.config, envKey);
}
