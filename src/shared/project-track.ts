import { z } from "zod";
import { PresentationSchema } from "./track-edit.js";
const id = z.string().min(1).max(200);
const sha = z.string().regex(/^[0-9a-f]{64}$/);
export const ProjectTrackSchema = z
  .object({
    entry: z.string().min(1).max(4096),
    sha256: sha,
    archive_id: id.optional(),
    entry_id: id.optional(),
    version_id: id.optional(),
    presentation_id: id.optional(),
    override: z
      .object({ settings: PresentationSchema, sha256: sha })
      .strict()
      .optional(),
  })
  .passthrough()
  .superRefine((v, ctx) => {
    const fields = [v.archive_id, v.entry_id, v.version_id, v.presentation_id];
    if ((fields.some(Boolean) || v.override) && !fields.every(Boolean))
      ctx.addIssue({
        code: "custom",
        message: "项目轨迹需完整固定库、行程、版本和展示引用",
      });
  });
export type ProjectTrack = z.infer<typeof ProjectTrackSchema>;
