import { z } from "zod";
const id = z.string().min(1).max(200);
const sha = z.string().regex(/^[0-9a-f]{64}$/);
/** A pinned archive track used by display export and history. */
export const TrackReferenceSchema = z
  .object({
    entry: z.string().min(1).max(4096),
    sha256: sha,
    archive_id: id,
    entry_id: id,
    version_id: id,
    presentation_id: id,
  })
  .strict();
export type TrackReference = z.infer<typeof TrackReferenceSchema>;
