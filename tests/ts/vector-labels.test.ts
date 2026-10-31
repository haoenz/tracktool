import { createRequire } from "node:module";
import Pbf from "pbf";
import { describe, expect, it } from "vitest";
import { labelVectorTile } from "../../src/infrastructure/maps/vector-labels.js";
import {
  MAP_LABEL_PROPERTY,
  MAP_LABEL_ORDER_PROPERTY,
} from "../../src/shared/map-label.js";

const require = createRequire(import.meta.url);
const decoderRequire = createRequire(require.resolve("vt-pbf"));
const { VectorTile } = decoderRequire("@mapbox/vector-tile") as {
  VectorTile: new (pbf: Pbf) => {
    layers: Record<
      string,
      {
        version: number;
        extent: number;
        length: number;
        feature(index: number): {
          properties: Record<string, string | number>;
          loadGeometry(): { x: number; y: number }[][];
        };
      }
    >;
  };
};
const bytes = (tag: number, data: Uint8Array) => {
  const pbf = new Pbf();
  pbf.writeBytesField(tag, data);
  return Buffer.from(pbf.finish());
};
const integer = (tag: number, value: number) => {
  const pbf = new Pbf();
  pbf.writeVarintField(tag, value);
  return Buffer.from(pbf.finish());
};
const id = Buffer.from([8, ...Array<number>(9).fill(255), 1]);
const geometry = bytes(4, Buffer.from([9, 20, 40]));
const unknown = bytes(10, Buffer.from("future field"));
function layer(
  name: string,
  properties: Record<string, string | number>,
  count = 1,
  overrides: { id?: Buffer; geometry?: Buffer } = {},
) {
  const tags = new Pbf();
  const entries = Object.entries(properties);
  entries.forEach((_, i) => {
    tags.writeVarint(i);
    tags.writeVarint(i);
  });
  const feature = bytes(
    2,
    Buffer.concat([
      overrides.id ?? id,
      bytes(2, tags.finish()),
      integer(3, 1),
      overrides.geometry ?? geometry,
      unknown,
    ]),
  );
  return bytes(
    3,
    Buffer.concat([
      bytes(1, Buffer.from(name)),
      integer(15, 2),
      integer(5, 8192),
      ...Array<Buffer>(count).fill(feature),
      ...entries.map(([key]) => bytes(3, Buffer.from(key))),
      ...entries.map(([, value]) =>
        bytes(
          4,
          typeof value === "string"
            ? bytes(1, Buffer.from(value))
            : integer(5, value),
        ),
      ),
    ]),
  );
}
const decode = (data: Buffer) => new VectorTile(new Pbf(data));

describe("vector tile labels", () => {
  it("adds one label and preserves original properties, IDs, geometry and unknown fields", () => {
    const properties = {
      name: "London",
      "name:zh": "伦敦;倫敦",
      "name:zh-Hans": "伦敦",
      ele: 12,
    };
    const original = layer("place", properties, 2);
    const snapshot = Buffer.from(original);
    const output = labelVectorTile(original);
    const result = decode(output).layers.place!;
    expect(result.version).toBe(2);
    expect(result.extent).toBe(8192);
    expect(result.length).toBe(2);
    for (let i = 0; i < result.length; i++) {
      expect(result.feature(i).properties).toEqual({
        ...properties,
        [MAP_LABEL_PROPERTY]: "伦敦",
        [MAP_LABEL_ORDER_PROPERTY]: expect.any(Number),
      });
      expect(result.feature(i).loadGeometry()).toEqual(
        decode(original).layers.place!.feature(i).loadGeometry(),
      );
    }
    for (const raw of [id, geometry, unknown])
      expect(output.includes(raw)).toBe(true);
    expect(original).toEqual(snapshot);
  });

  it("keeps place tie-breaks stable across tiles, tag order and uint64 IDs", () => {
    const order = (tile: Buffer) =>
      decode(labelVectorTile(tile)).layers.place!.feature(0).properties[
        MAP_LABEL_ORDER_PROPERTY
      ];
    const properties = { name: "同名", class: "country", rank: 1 };
    const first = order(layer("place", properties));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
    expect(
      order(
        layer("place", { rank: 1, class: "country", name: "同名" }, 1, {
          geometry: bytes(4, Buffer.from([9, 40, 60])),
        }),
      ),
    ).toBe(first);
    // These two IDs differ below JavaScript's integer precision at uint64 max.
    const nextId = Buffer.from(id);
    nextId[1] = 254;
    expect(order(layer("place", properties, 1, { id: nextId }))).not.toBe(
      first,
    );
    expect(
      order(layer("place", { ...properties, [MAP_LABEL_ORDER_PROPERTY]: 999 })),
    ).toBe(first);
    const withoutId = { id: Buffer.alloc(0) };
    expect(order(layer("place", properties, 1, withoutId))).toBe(
      order(
        layer("place", { rank: 1, name: "同名", class: "country" }, 1, {
          ...withoutId,
          geometry: bytes(4, Buffer.from([9, 40, 60])),
        }),
      ),
    );
  });

  it.each([
    "place",
    "transportation_name",
    "poi",
    "mountain_peak",
    "water_name",
    "park",
    "aerodrome_label",
  ])("normalizes the %s label layer", (name) => {
    const output = labelVectorTile(layer(name, { "name:zh": "东京都/東京都" }));
    expect(
      decode(output).layers[name]!.feature(0).properties[MAP_LABEL_PROPERTY],
    ).toBe("东京都");
  });

  it("leaves non-label layers and empty layers unchanged", () => {
    const data = Buffer.concat([
      layer("water", { name: "甲;乙" }),
      layer("place", {}, 0),
    ]);
    expect(labelVectorTile(data)).toEqual(data);
  });

  it("does not use a stale derived property or fabricate a name for unnamed features", () => {
    const output = labelVectorTile(
      layer("place", { [MAP_LABEL_PROPERTY]: "旧名;舊名" }),
    );
    expect(
      decode(output).layers.place!.feature(0).properties[MAP_LABEL_PROPERTY],
    ).toBe("");
    const first = labelVectorTile(layer("place", { name: "臺北" }));
    expect(
      decode(labelVectorTile(first)).layers.place!.feature(0).properties,
    ).toEqual(decode(first).layers.place!.feature(0).properties);
  });

  it.each([
    Buffer.from([26, 100, 0]),
    Buffer.from([27]),
    Buffer.from([26, 1, 0]),
  ])(
    "rejects malformed protobuf without returning a partially rewritten tile",
    (data) => {
      expect(() => labelVectorTile(data)).toThrow("无效矢量名称数据");
    },
  );

  it("rejects feature tag indexes outside the layer tables", () => {
    const feature = bytes(2, bytes(2, Buffer.from([0, 9])));
    const data = bytes(
      3,
      Buffer.concat([
        bytes(1, Buffer.from("place")),
        integer(15, 2),
        bytes(3, Buffer.from("name")),
        feature,
      ]),
    );
    expect(() => labelVectorTile(data)).toThrow("无效矢量名称数据");
  });
});
