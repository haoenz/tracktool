import { z } from "zod";

export const LogLevelSchema = z.enum([
  "DEBUG",
  "VERBOSE",
  "INFO",
  "WARNING",
  "ERROR",
]);
export const CategorySchema = z.enum(["Default", "Train", "Flight"]);
export const RunModeSchema = z.enum(["plan", "apply"]);
export const ErrorCodeSchema = z.enum([
  "USER_INPUT",
  "TOOL",
  "PARTIAL",
  "CANCELLED",
  "FORBIDDEN",
  "INTERNAL",
]);
export const ErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  exitCode: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(130)]),
});
export const ErrorResponseSchema = z.object({ error: ErrorSchema });
export type ErrorInfo = z.infer<typeof ErrorSchema>;
export const PublicConfigSchema = z
  .object({
    log_level: LogLevelSchema,
    archive_path: z.string(),
    archive_history: z.boolean(),
    kml_backup_dir_name: z.string(),
    google_api_key_configured: z.boolean(),
    "track_tag.Default": z.array(z.string()),
    "track_tag.Train": z.array(z.string()),
    "track_tag.Flight": z.array(z.string()),
  })
  .strict();
export type PublicConfig = z.infer<typeof PublicConfigSchema>;
export const ConfigResponseSchema = z.object({ data: PublicConfigSchema });
export const ProgressSchema = z
  .object({
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .refine((p) => p.completed <= p.total, "completed exceeds total");
export const TaskStateSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "interrupted",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;
export const ItemResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded"), path: z.string() }),
  z.object({
    status: z.literal("skipped"),
    path: z.string(),
    reason: z.string(),
  }),
  z.object({
    status: z.literal("failed"),
    path: z.string(),
    error: ErrorSchema,
  }),
]);
export const BatchResultSchema = z
  .object({
    items: z.array(ItemResultSchema),
    exitCode: z.union([z.literal(0), z.literal(3)]),
  })
  .refine(
    (r) => r.exitCode === (r.items.some((i) => i.status === "failed") ? 3 : 0),
    "batch exit code mismatch",
  );
export type BatchResult = z.infer<typeof BatchResultSchema>;
export const TaskSchema = z
  .object({
    schema: z.literal(1),
    id: z.string().min(1),
    operation: z.string().min(1),
    mode: RunModeSchema,
    status: TaskStateSchema,
    revision: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    progress: ProgressSchema,
    result: BatchResultSchema.optional(),
    error: ErrorSchema.optional(),
  })
  .strict();
export type Task = z.infer<typeof TaskSchema>;
export const TaskEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("log"),
    level: LogLevelSchema,
    message: z.string(),
  }),
  z
    .object({
      type: z.literal("progress"),
      completed: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .refine((p) => p.completed <= p.total),
]);
export type TaskEvent = z.infer<typeof TaskEventSchema>;
// Signed int64 microseconds travel as decimal strings, never JSON numbers.
export const MicrosecondsSchema = z
  .string()
  .regex(/^-?(0|[1-9]\d*)$/)
  .refine((v) => {
    if (!/^-?(0|[1-9]\d*)$/.test(v)) return false;
    const n = BigInt(v);
    return n >= -(1n << 63n) && n < 1n << 63n;
  }, "outside signed int64");
