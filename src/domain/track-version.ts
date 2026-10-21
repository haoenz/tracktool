import { AppError } from "./errors.js";
import { PresentationSchema, type Presentation } from "../shared/track-edit.js";
export { PresentationSchema } from "../shared/track-edit.js";
export type {
  Presentation,
  EntryState,
  VersionRef,
  EntrySnapshot,
  SegmentManifest,
  Manifest,
} from "../shared/track-edit.js";
export function validatePresentation(
  input: unknown,
  segments: string[],
): Presentation {
  const result = PresentationSchema.safeParse(input);
  if (!result.success) throw new AppError("USER_INPUT", "展示设置校验失败");
  const value = result.data,
    available = new Set(segments);
  if (
    available.size !== segments.length ||
    available.size !== value.order.length ||
    value.order.some((s) => !available.has(s))
  )
    throw new AppError("USER_INPUT", "展示设置必须且只能包含每个版本片段一次");
  return value;
}
