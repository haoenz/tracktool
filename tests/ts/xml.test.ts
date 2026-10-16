import { afterEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { XmlWorkers } from "../../dist/node/infrastructure/xml/client.js";
import {
  withDocument,
  xpathLiteral,
  namespaces,
} from "../../dist/node/infrastructure/xml/document.js";
import expected from "./fixtures/xml/expected.json";

const pools: XmlWorkers[] = [];
function pool(concurrency = 2, queue = 8, timeout = 15_000) {
  const p = new XmlWorkers(concurrency, queue, timeout);
  pools.push(p);
  return p;
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close()));
});
const sample = (name: string) =>
  readFile(new URL(`./fixtures/xml/${name}`, import.meta.url));
it("accepts XML results after Node watch dependency notifications", async () => {
  vi.stubEnv("WATCH_REPORT_DEPENDENCIES", "1");
  try {
    await expect(
      pool().run(await sample("complex.kml"), { kind: "inspect" }),
    ).resolves.toMatchObject({ name: "原始中文", placemarks: 1 });
  } finally {
    vi.unstubAllEnvs();
  }
});
it("settles ESM initialization before repeated concurrent worker disposal", async () => {
  const bytes = await sample("complex.kml"),
    p = pool(4, 40);
  const results = await Promise.all(
    Array.from({ length: 32 }, () => p.run(bytes, { kind: "inspect" })),
  );
  expect(results).toHaveLength(32);
  expect(results.every((r) => r.name === "原始中文")).toBe(true);
}, 30_000);
it.each(Object.keys(expected.valid))(
  "strict byte decoding, query and edit round-trip: %s",
  async (name) => {
    const bytes = await sample(name),
      p = pool();
    expect(await p.run(bytes, { kind: "inspect" })).toMatchObject({
      name: "原始中文",
      placemarks: 1,
      coordinateNodes: 5,
    });
    const renamed = `中文 'single' "double" <>&`;
    const result = await p.run(bytes, { kind: "rename", name: renamed });
    const edited = new TextEncoder().encode(result.xml!);
    expect((await p.run(edited, { kind: "inspect" })).name).toBe(renamed);
    withDocument(edited, (doc) => {
      expect(
        doc.find(
          `/kml:kml/kml:Document[kml:name=${xpathLiteral(renamed)}]`,
          namespaces,
        ),
      ).toHaveLength(1);
      expect(doc.find("//gx:coord", namespaces).map((n) => n.content)).toEqual([
        "103 29 9",
        "104 30",
      ]);
      expect(result.xml).toContain("untouched");
    });
  },
);
it.each(expected.invalid)("rejects malformed XML: %s", async (name) => {
  await expect(
    pool().run(await sample(name), { kind: "inspect" }),
  ).rejects.toMatchObject({ code: "USER_INPUT" });
});
it("disposes on errors and does not resolve external entities", () => {
  let dispose: ReturnType<typeof vi.spyOn> | undefined;
  expect(() =>
    withDocument(new TextEncoder().encode("<root/>"), (doc) => {
      dispose = vi.spyOn(doc, "dispose");
      throw new Error("test");
    }),
  ).toThrow("test");
  expect(dispose).toHaveBeenCalledTimes(1);
  withDocument(
    new TextEncoder().encode(
      '<!DOCTYPE root [<!ENTITY x SYSTEM "file:///etc/hostname">]><root>&x;</root>',
    ),
    (doc) => {
      expect(doc.root.content).toBe("");
    },
  );
});
it("cancels queued/running work, enforces capacity, and recovers after failure", async () => {
  const p = pool(1, 1),
    bytes = await sample("complex.kml");
  const runningAbort = new AbortController(),
    queuedAbort = new AbortController();
  const running = p.run(bytes, { kind: "inspect" }, runningAbort.signal);
  const queued = p.run(bytes, { kind: "inspect" }, queuedAbort.signal);
  await expect(p.run(bytes, { kind: "inspect" })).rejects.toThrow("队列已满");
  const runningCheck = expect(running).rejects.toMatchObject({
    code: "CANCELLED",
  });
  const queuedCheck = expect(queued).rejects.toMatchObject({
    code: "CANCELLED",
  });
  queuedAbort.abort();
  runningAbort.abort();
  await Promise.all([runningCheck, queuedCheck]);
  await expect(
    p.run(await sample("unclosed.kml"), { kind: "inspect" }),
  ).rejects.toMatchObject({ code: "USER_INPUT" });
  expect((await p.run(bytes, { kind: "inspect" })).name).toBe("原始中文");
});
it("times out and shuts down with outstanding requests", async () => {
  const bytes = await sample("complex.kml");
  await expect(pool(1, 1, 1).run(bytes, { kind: "inspect" })).rejects.toThrow(
    "超时",
  );
  const p = pool(1, 1);
  const a = expect(p.run(bytes, { kind: "inspect" })).rejects.toMatchObject({
    code: "CANCELLED",
  });
  const b = expect(p.run(bytes, { kind: "inspect" })).rejects.toMatchObject({
    code: "CANCELLED",
  });
  await p.close();
  await Promise.all([a, b]);
  await expect(p.run(bytes, { kind: "inspect" })).rejects.toMatchObject({
    code: "CANCELLED",
  });
});
