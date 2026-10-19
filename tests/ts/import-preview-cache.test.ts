import { it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ImportPreviewCache } from "../../dist/node/infrastructure/import-preview-cache.js";
import { XmlWorkers } from "../../dist/node/infrastructure/xml/client.js";
import { AppError } from "../../dist/node/domain/errors.js";
import type { Source } from "../../dist/node/services/kml-service.js";
import type { XmlPort } from "../../dist/node/services/ports.js";
const source = (bytes: Uint8Array, path = "/fixture.kml"): Source => ({
  bytes,
  path,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  name: "fixture.kml",
  stem: "fixture",
  directory: "/",
});

it("reuses validation and edited digests but invalidates by bytes, expiry and capacity", async () => {
  const bytes = await readFile("tests/ts/fixtures/m4/2026-10-01 轨迹.kml");
  const workers = new XmlWorkers();
  const run = vi.fn(workers.run.bind(workers));
  let now = 0;
  const cache = new ImportPreviewCache(2, 100, () => now);
  const input = source(bytes);
  try {
    const first = await cache.inspect(input, { run });
    expect(first).toEqual({ tag: "火车", sha256: input.sha256 });
    expect(run.mock.calls.map((call) => call[1].kind)).toEqual([
      "content",
      "tracks",
    ]);
    await cache.inspect({ ...input, name: "renamed.kml" }, { run });
    expect(run).toHaveBeenCalledTimes(2);
    const changed = await cache.inspect(input, { run }, "徒步");
    const actual = await workers.run(bytes, {
      kind: "edit",
      operation: { kind: "set-tag", tag: "徒步", create: true },
    });
    expect(changed.sha256).toBe(
      createHash("sha256").update(actual.edit!.outputs[0]!.xml).digest("hex"),
    );
    expect(changed.tag).toBe("火车");
    await cache.inspect(input, { run }, "徒步");
    expect(run).toHaveBeenCalledTimes(3);
    const edited = source(
      Buffer.from(bytes.toString().replace("火车", "飞机")),
    );
    expect((await cache.inspect(edited, { run })).tag).toBe("飞机");
    expect(run).toHaveBeenCalledTimes(5);
    now = 101;
    await cache.inspect(input, { run });
    expect(run).toHaveBeenCalledTimes(7);
    await cache.inspect(source(bytes, "/second.kml"), { run });
    await cache.inspect(source(bytes, "/third.kml"), { run });
    await cache.inspect(input, { run });
    expect(run).toHaveBeenCalledTimes(13);
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      cache.inspect(input, { run }, undefined, aborted.signal),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(run).toHaveBeenCalledTimes(13);
  } finally {
    await workers.close();
  }
});

it("caches deterministic validation errors but retries worker failures and changed content", async () => {
  const cache = new ImportPreviewCache();
  const input = source(Buffer.from("invalid"));
  const invalid = vi
    .fn<XmlPort["run"]>()
    .mockRejectedValue(new AppError("USER_INPUT", "XML 格式或编码无效"));
  await expect(cache.inspect(input, { run: invalid })).rejects.toThrow(
    "XML 格式",
  );
  await expect(cache.inspect(input, { run: invalid })).rejects.toThrow(
    "XML 格式",
  );
  expect(invalid).toHaveBeenCalledTimes(1);
  const changed = source(Buffer.from("changed"));
  const transient = vi
    .fn<XmlPort["run"]>()
    .mockRejectedValue(new AppError("TOOL", "XML 处理超时"));
  await expect(cache.inspect(changed, { run: transient })).rejects.toThrow(
    "XML 处理超时",
  );
  await expect(cache.inspect(changed, { run: transient })).rejects.toThrow(
    "XML 处理超时",
  );
  expect(transient).toHaveBeenCalledTimes(2);
});
