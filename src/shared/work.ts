import { z } from "zod";
import type { Task, TaskEvent } from "./contracts.js";
export const OPERATIONS = {
  "archive:init": "建立归档",
  "archive:import-zip": "导入 ZIP",
  "archive:status": "归档状态",
  "archive:push": "轨迹入库",
  "archive:pop": "取回轨迹",
  "archive:backup": "ZIP 备份",
  "archive:rebuild": "聚合导出",
  "archive:recover": "恢复中断操作",
  "archive:migrate": "升级数据库",
  "kml:type": "检查分类",
  "kml:set-tag": "设置活动标签",
  "kml:split": "拆分轨迹",
  "kml:prune": "清理轨迹点",
  "kml:merge": "合并轨迹",
  "kml:to-multigeom": "转换 MultiGeometry",
  "kml:fill-altitude": "补全轨迹高程",
  "exif:info": "查看元数据",
  "exif:show-missing": "检查缺失标签",
  "exif:set": "设置元数据",
  "exif:geotag": "按轨迹定位",
  "exif:fill-altitude": "补全媒体海拔",
  "exif:set-location": "补全地名",
  "exif:shift-time": "调整拍摄时间",
  "exif:shift-altitude": "调整海拔",
  "exif:to-mp4": "转封装 MP4",
  "exif:group": "整理媒体分类",
  "exif:repair": "修复 GPS 与海拔",
  "exif:repair-vid": "修复视频目录",
} as const;
export type Operation = keyof typeof OPERATIONS;
export const READ_OPERATIONS: readonly Operation[] = [
  "archive:status",
  "kml:type",
  "exif:info",
  "exif:show-missing",
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
        category: z.enum(["Default", "Train", "Flight"]).optional(),
        tag: text.optional(),
        create: z.boolean().optional(),
        keep: z.boolean().optional(),
        name: text.optional(),
        auto: z.boolean().optional(),
        points: z.array(text).max(1000).optional(),
        gapSeconds: nonnegative.optional(),
        gapMeters: nonnegative.optional(),
        speedMps: nonnegative.optional(),
        jumpMeters: nonnegative.optional(),
        returnMeters: nonnegative.optional(),
        maxSeconds: nonnegative.optional(),
        connected: z.boolean().optional(),
        position: text.optional(),
        altitude: finite.optional(),
        tags: z.record(z.string().regex(/^[A-Za-z][\w:-]*$/), text).optional(),
        missingTags: z
          .array(z.string().regex(/^[A-Za-z][\w:-]*$/))
          .max(100)
          .optional(),
        make: text.optional(),
        model: text.optional(),
        by: text.optional(),
        offset: text.optional(),
        delta: finite.optional(),
        overwrite: z.boolean().optional(),
        parallel: z.boolean().optional(),
        failedFolder: z
          .string()
          .regex(/^[^/\\.][^/\\]*$/)
          .max(120)
          .optional(),
        policy: z.enum(["auto", "keep", "force"]).optional(),
        source: text.optional(),
        force: z.boolean().optional(),
        verify: z.boolean().optional(),
        multiday: z.boolean().optional(),
        maxDistance: nonnegative.optional(),
        language: z.string().max(40).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type WorkRequest = z.infer<typeof WorkRequestSchema>;
export interface WorkOutput {
  paths: string[];
  data?: unknown;
}
export interface WorkTask extends Task {
  request: WorkRequest;
  previewId?: string;
  expiresAt?: string;
  output?: WorkOutput;
  events: { sequence: number; event: TaskEvent }[];
  cancelRequested: boolean;
}
export interface FileEntry {
  name: string;
  path: string;
  directory: boolean;
  size: number;
}
export interface FileListing {
  path: string;
  parent: string;
  roots: string[];
  entries: FileEntry[];
}
export interface UploadResult {
  id: string;
  directory: string;
  files: string[];
  bytes: number;
}
