import { z } from "zod";
import { DeleteRequestSchema } from "./archive-actions.js";
import { TaskEventSchema, TaskSchema } from "./contracts.js";
import { COMPRESSION_PRESETS, EXPORT_FORMATS } from "./export-format.js";
import { EditApplySchema, EditRequestSchema } from "./track-edit.js";
export const OPERATIONS = {
  "archive:init": "建立归档",
  "archive:import-zip": "导入 ZIP",
  "archive:status": "归档状态",
  "archive:push": "轨迹入库",
  "archive:download": "下载轨迹",
  "archive:delete": "删除轨迹及历史",
  "archive:backup": "导出展示压缩包",
  "archive:rebuild": "聚合导出",
  "archive:recover": "恢复中断操作",
  "kml:type": "检查分类",
  "kml:set-tag": "设置活动标签",
  "kml:split": "拆分轨迹",
  "kml:prune": "清理轨迹点",
  "kml:merge": "合并轨迹",
  "track:preview": "轨迹编辑预览",
  "track:apply": "应用轨迹编辑",
  "kml:fill-altitude": "补全轨迹高程",
} as const;
export type Operation = keyof typeof OPERATIONS;
export const READ_OPERATIONS: readonly string[] = [
  "archive:status",
  "kml:type",
];
const text = z.string().max(4096),
  finite = z.number().finite(),
  nonnegative = finite.nonnegative();
export const WorkRequestSchema = z
  .object({
    operation: z.enum(Object.keys(OPERATIONS) as [Operation, ...Operation[]]),
    inputs: z.array(text.min(1)).max(500).default([]),
    archive: text.optional(),
    output: text.optional(),
    options: z
      .object({
        format: z.enum(EXPORT_FORMATS).optional(),
        compression: z.enum(COMPRESSION_PRESETS).optional(),
        category: z.enum(["Default", "Train", "Flight"]).optional(),
        retainUploads: z.boolean().optional(),
        importFiles: z
          .array(
            z
              .object({
                path: text.min(1),
                tag: text.min(1).optional(),
                name: z
                  .string()
                  .min(1)
                  .max(240)
                  .regex(/^[^/\\:\x00-\x1f]+\.kml$/i)
                  .optional(),
              })
              .strict(),
          )
          .max(500)
          .optional(),
        tag: text.optional(),
        create: z.boolean().optional(),
        keep: z.boolean().optional(),
        name: text.optional(),
        entries: z.array(text.min(1)).min(1).optional(),
        entryId: text.optional(),
        versionId: text.optional(),
        deletion: DeleteRequestSchema.optional(),
        trackPreview: z
          .object({ id: z.string().uuid(), request: EditRequestSchema })
          .strict()
          .optional(),
        trackApply: EditApplySchema.optional(),
        auto: z.boolean().optional(),
        points: z.array(text).max(1000).optional(),
        gapSeconds: nonnegative.optional(),
        gapMeters: nonnegative.optional(),
        speedMps: nonnegative.optional(),
        jumpMeters: nonnegative.optional(),
        returnMeters: nonnegative.optional(),
        maxSeconds: nonnegative.optional(),
        connected: z.boolean().optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type WorkRequest = z.infer<typeof WorkRequestSchema>;
export interface ImportItem {
  path: string;
  member?: string;
  entryId?: string;
  category?: string;
  tag?: string;
  sourceTag?: string;
  status: "new" | "duplicate" | "conflict" | "invalid";
  reason: string;
}
export const WorkOutputSchema = z.object({
  paths: z.array(z.string()),
  temporary: z.boolean().optional(),
  data: z.unknown().optional(),
  committed: z.boolean().optional(),
});
export type WorkOutput = z.infer<typeof WorkOutputSchema>;
// Responses must contain normalized inputs/options; request defaults must not hide omissions.
const TaskRequestSchema = WorkRequestSchema.extend({
  inputs: WorkRequestSchema.shape.inputs.removeDefault(),
  options: WorkRequestSchema.shape.options.removeDefault(),
});
export const WorkTaskSchema = TaskSchema.extend({
  uploadsCleaned: z.boolean().optional(),
  exportsCleaned: z.boolean().optional(),
  downloadedFiles: z.array(z.number().int().nonnegative()).optional(),
  request: TaskRequestSchema,
  previewId: z.string().min(1).optional(),
  expiresAt: z.iso.datetime().optional(),
  output: WorkOutputSchema.optional(),
  events: z.array(
    z.object({
      sequence: z.number().int().nonnegative(),
      event: TaskEventSchema,
    }),
  ),
  cancelRequested: z.boolean(),
});
export type WorkTask = z.infer<typeof WorkTaskSchema>;
export interface UploadResult {
  id: string;
  directory: string;
  files: string[];
  bytes: number;
}

export function executableOperation(value: string): value is Operation {
  return Object.hasOwn(OPERATIONS, value);
}
export function operationLabel(value: string): string {
  return executableOperation(value)
    ? OPERATIONS[value]
    : `${value}（未知操作）`;
}
