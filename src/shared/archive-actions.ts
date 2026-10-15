import { z } from "zod";

const id = z.string().min(1).max(200);
export const ArchiveRefSchema = z
  .object({
    entry_id: id,
    version_id: id,
    presentation_id: id,
    generation: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const DeleteRequestSchema = z
  .object({
    archive_id: id,
    request_key: id,
    expected: ArchiveRefSchema,
  })
  .strict();
export type DeleteRequest = z.infer<typeof DeleteRequestSchema>;
export type DeleteDependency = {
  kind: "trajectory" | "project" | "pending";
  id: string;
  detail: string;
};
export type DeletePreview = {
  archive_id: string;
  expected: z.infer<typeof ArchiveRefSchema>;
  path: string;
  versions: number;
  presentations: number;
  segments: number;
  removable_objects: number;
  shared_objects: number;
  dependencies: DeleteDependency[];
};
export type DeleteResult = {
  entry_id: string;
  path: string;
  versions: number;
  deleted_objects: number;
};
