import { expect, it } from "vitest";
import { publicOrigin } from "../../src/server/access.js";

it("rejects ambiguous public addresses and Access without a public address", () => {
  for (const value of [
    "http://tracks.test",
    "https://user:pass@tracks.test",
    "https://tracks.test/map",
    "https://tracks.test/?a=1",
    "https://tracks.test/#fragment",
    "//tracks.test",
    "invalid",
  ])
    expect(() => publicOrigin({ publicOrigin: value })).toThrow(
      "公开访问地址必须",
    );
  expect(() => publicOrigin({ cloudflareAccess: true })).toThrow(
    "需要配置公开访问地址",
  );
  expect(publicOrigin({})).toBeUndefined();
  expect(
    publicOrigin({ publicOrigin: "https://tracks.test:8443/" })?.origin,
  ).toBe("https://tracks.test:8443");
});
