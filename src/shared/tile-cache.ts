import { z } from "zod";

export const TileCacheCapacitySchema = z
  .number({ error: "瓦片缓存容量需为 1–16384 MiB 的整数" })
  .int("瓦片缓存容量需为整数")
  .min(1, "瓦片缓存容量至少为 1 MiB")
  .max(16384, "瓦片缓存容量不能超过 16384 MiB");
export const TileCacheSettingsSchema = z.object({
  capacityMiB: TileCacheCapacitySchema,
  readOnly: z.boolean(),
});
export type TileCacheSettings = z.infer<typeof TileCacheSettingsSchema>;
