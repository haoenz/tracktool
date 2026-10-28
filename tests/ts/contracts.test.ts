import { describe, expect, it } from "vitest";
import { defaultMapState, MapStateSchema } from "../../src/shared/map-state.js";
import { PrintDocumentSchema, printDocument } from "../../src/shared/print.js";
import {
  BatchResultSchema,
  MicrosecondsSchema,
  TaskSchema,
} from "../../src/shared/contracts.js";
import { assertTransition, batchResult } from "../../src/domain/tasks.js";
import { AppError, errorInfo } from "../../src/domain/errors.js";
import {
  DEFAULTS,
  changeTagList,
  normalizeScalar,
  parseBool,
  parseTagSpec,
  resolveApiKey,
  tagMap,
} from "../../src/domain/config.js";
import { createContext } from "../../src/services/context.js";
import { getPublicConfig } from "../../src/services/config.js";

describe("shared contracts", () => {
  const state = defaultMapState();
  const document = printDocument(state, "archive.sqlite3", [
    { entry: "Train/a.kml", sha256: "a".repeat(64) },
  ]);
  it("accepts a print document and preserves extension fields", () => {
    expect(
      PrintDocumentSchema.parse({ ...document, extension: { future: true } })
        .extension,
    ).toEqual({ future: true });
    expect(MapStateSchema.parse(state).camera).toEqual(state.camera);
  });
  it.each([
    { ...document, version: 2 },
    { ...document, title: "a\nb" },
    { ...document, title: "字".repeat(61) },
    { ...document, output: { width: 1920, height: 1000 } },
    { ...document, camera: { ...document.camera, center: [181, 30] } },
    {
      ...document,
      tracks: [
        { entry: "a", sha256: "a".repeat(64) },
        { entry: "a", sha256: "b".repeat(64) },
      ],
    },
  ])("rejects invalid print values", (value) => {
    expect(PrintDocumentSchema.safeParse(value).success).toBe(false);
  });
  it("keeps int64 timestamps exact and rejects malformed and overflowing values", () => {
    for (const value of [
      "-9223372036854775808",
      "9223372036854775807",
      "1790812800123456",
    ])
      expect(MicrosecondsSchema.parse(value)).toBe(value);
    for (const value of [
      "9223372036854775808",
      "1.1",
      "",
      "hello",
      1790812800123456,
    ])
      expect(MicrosecondsSchema.safeParse(value).success).toBe(false);
  });
  it("maps partial failures and prevents contradictory batch results", () => {
    const items = [
      { status: "succeeded" as const, path: "a" },
      {
        status: "failed" as const,
        path: "b",
        error: errorInfo(new AppError("TOOL", "failure")),
      },
    ];
    expect(batchResult(items).exitCode).toBe(3);
    expect(BatchResultSchema.safeParse({ items, exitCode: 0 }).success).toBe(
      false,
    );
  });
  it("validates progress and terminal task transitions", () => {
    const task = {
      schema: 1,
      id: "a",
      operation: "inspect",
      mode: "plan",
      status: "queued",
      revision: 0,
      createdAt: "2026-10-14T00:00:00Z",
      updatedAt: "2026-10-14T00:00:00Z",
      progress: { completed: 0, total: 1 },
    };
    expect(TaskSchema.safeParse(task).success).toBe(true);
    expect(
      TaskSchema.safeParse({ ...task, progress: { completed: 2, total: 1 } })
        .success,
    ).toBe(false);
    assertTransition("queued", "running");
    assertTransition("running", "interrupted");
    expect(() => assertTransition("succeeded", "running")).toThrow();
  });
  it.each([
    ["USER_INPUT", 1],
    ["TOOL", 2],
    ["PARTIAL", 3],
    ["CANCELLED", 130],
  ] as const)("maps %s to %s", (code, expected) => {
    expect(errorInfo(new AppError(code, "test")).exitCode).toBe(expected);
  });
  it("does not expose unexpected exception details", () => {
    expect(errorInfo(new Error("secret")).message).not.toContain("secret");
  });
});
describe("configuration and invocation context", () => {
  it("normalizes values, moves tags, and rejects cross-category duplicates", () => {
    expect(parseBool("YES")).toBe(true);
    expect(parseBool("off")).toBe(false);
    expect(parseBool("invalid")).toBeUndefined();
    expect(normalizeScalar("log_level", "verbose")).toBe("VERBOSE");
    expect(() => normalizeScalar("archive_history", "invalid")).toThrow();
    expect(() => normalizeScalar("constructor", "invalid")).toThrow();
    expect(parseTagSpec("+徒步,新标签,新标签").names).toEqual([
      "徒步",
      "新标签",
    ]);
    expect(() => parseTagSpec("+")).toThrow();
    const updated = changeTagList(DEFAULTS, "track_tag.Train", "+徒步");
    expect(tagMap(updated).get("徒步")).toBe("Train");
    expect(tagMap(DEFAULTS).get("徒步")).toBe("Default");
    expect(() =>
      tagMap({ ...DEFAULTS, "track_tag.Train": ["徒步"] }),
    ).toThrow();
    expect(resolveApiKey({ google_api_key: "stored" }, "env", "override")).toBe(
      "env",
    );
  });
  it("isolates contexts and exposes only allowlisted configuration", () => {
    const input = {
      ...DEFAULTS,
      google_api_key: "private-key",
      custom: "private-extra",
    };
    const a = createContext({ config: input, mode: "plan" }),
      b = createContext({ config: input });
    input.google_api_key = "changed";
    expect(a.config.google_api_key).toBe("private-key");
    expect(b.mode).toBe("apply");
    expect(a.signal).not.toBe(b.signal);
    expect(() => {
      a.config.google_api_key = "mutation";
    }).toThrow();
    const summary = getPublicConfig(a);
    expect(summary.google_api_key_configured).toBe(true);
    expect(JSON.stringify(summary)).not.toMatch(/private|custom/);
    const abort = new AbortController();
    abort.abort();
    expect(() =>
      getPublicConfig(
        createContext({ config: DEFAULTS, signal: abort.signal }),
      ),
    ).toThrow("取消");
  });
});
