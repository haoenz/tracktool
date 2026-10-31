import Pbf from "pbf";
import { createHash } from "node:crypto";
import { AppError } from "../../domain/errors.js";
import { mapLabel } from "../../domain/map-label.js";
import {
  MAP_LABEL_PROPERTY,
  MAP_LABEL_ORDER_PROPERTY,
} from "../../shared/map-label.js";

export const vectorLabelVersion = "single-map-label-v2";
const labelLayers = new Set([
  "place",
  "transportation_name",
  "poi",
  "mountain_peak",
  "water_name",
  "park",
  "aerodrome_label",
]);
type Field = { tag: number; wire: number; raw: Buffer; value: Buffer };

function fields(data: Buffer): Field[] {
  const reader = new Pbf(data);
  const result: Field[] = [];
  while (reader.pos < data.length) {
    const start = reader.pos;
    const key = reader.readVarint();
    const tag = Math.floor(key / 8);
    const wire = key & 7;
    if (!tag || ![0, 1, 2, 5].includes(wire))
      throw new Error("Invalid protobuf field");
    const valueStart = reader.pos;
    const value = wire === 2 ? Buffer.from(reader.readBytes()) : undefined;
    if (wire !== 2) reader.skip(key);
    if (reader.pos > data.length) throw new Error("Truncated protobuf field");
    result.push({
      tag,
      wire,
      raw: data.subarray(start, reader.pos),
      value: value ?? data.subarray(valueStart, reader.pos),
    });
  }
  return result;
}

function bytesField(tag: number, value: Uint8Array): Buffer {
  const writer = new Pbf();
  writer.writeBytesField(tag, value);
  return Buffer.from(writer.finish());
}

function addLabels(data: Buffer): Buffer {
  const layer = fields(data);
  const name = layer
    .find((field) => field.tag === 1 && field.wire === 2)
    ?.value.toString("utf8");
  if (!name || !labelLayers.has(name)) return data;
  const keys = layer
    .filter((field) => field.tag === 3 && field.wire === 2)
    .map((field) => field.value.toString("utf8"));
  const values = layer
    .filter((field) => field.tag === 4 && field.wire === 2)
    .map((field) => {
      const text = fields(field.value).find(
        (item) => item.tag === 1 && item.wire === 2,
      );
      return text?.value.toString("utf8");
    });
  const labelKey = keys.indexOf(MAP_LABEL_PROPERTY);
  const keyIndex = labelKey < 0 ? keys.length : labelKey;
  const orderKey = keys.indexOf(MAP_LABEL_ORDER_PROPERTY);
  const orderIndex =
    orderKey < 0 ? keys.length + Number(labelKey < 0) : orderKey;
  const labels = new Map<string, number>();
  const additions: Buffer[] = [];
  const output = layer.map((field) => {
    if (field.tag !== 2 || field.wire !== 2) return field.raw;
    const feature = fields(field.value);
    const properties: Record<string, string> = {};
    const tags: number[] = [];
    for (const tagField of feature.filter((item) => item.tag === 2)) {
      if (tagField.wire !== 2) throw new Error("Invalid feature tags");
      const reader = new Pbf(tagField.value);
      while (reader.pos < reader.length) {
        const key = reader.readVarint();
        const value = reader.readVarint();
        if (
          reader.pos > reader.length ||
          key >= keys.length ||
          value >= values.length
        )
          throw new Error("Invalid feature tag index");
        if (key !== labelKey && (name !== "place" || key !== orderKey))
          tags.push(key, value);
        const property = keys[key]!;
        if (
          (property === "name" ||
            property.startsWith("name:") ||
            property === "class" ||
            property === "iso_a2") &&
          values[value] !== undefined
        )
          properties[property] = values[value]!;
      }
    }
    const label = mapLabel(properties);
    let valueIndex = labels.get(label);
    if (valueIndex === undefined) {
      valueIndex = values.length + additions.length;
      labels.set(label, valueIndex);
      additions.push(bytesField(4, bytesField(1, Buffer.from(label))));
    }
    tags.push(keyIndex, valueIndex);
    if (name === "place") {
      // Use the raw uint64 ID to keep ties stable across tiles and pans without
      // rounding large IDs. Geometry is tile-relative and cannot be an identity.
      const identity =
        feature.find((item) => item.tag === 1 && item.wire === 0)?.value ??
        Buffer.from(
          JSON.stringify([
            properties.class,
            properties.iso_a2,
            properties.name ?? properties["name:en"] ?? label,
          ]),
        );
      const order =
        createHash("sha256").update(identity).digest().readUInt32BE(0) /
        2 ** 32;
      const value = new Pbf();
      value.writeDoubleField(3, order);
      tags.push(orderIndex, values.length + additions.length);
      additions.push(bytesField(4, value.finish()));
    }
    const writer = new Pbf();
    for (const tag of tags) writer.writeVarint(tag);
    // Copy IDs, geometry commands and unknown fields byte for byte. Rebuilding
    // geometries or decoding uint64 feature IDs could lose source precision.
    return bytesField(
      2,
      Buffer.concat([
        ...feature.filter((item) => item.tag !== 2).map((item) => item.raw),
        bytesField(2, writer.finish()),
      ]),
    );
  });
  if (!labels.size) return data;
  if (labelKey < 0) output.push(bytesField(3, Buffer.from(MAP_LABEL_PROPERTY)));
  if (name === "place" && orderKey < 0)
    output.push(bytesField(3, Buffer.from(MAP_LABEL_ORDER_PROPERTY)));
  return Buffer.concat([...output, ...additions]);
}

export function labelVectorTile(data: Buffer): Buffer {
  try {
    return Buffer.concat(
      fields(data).map((field) =>
        field.tag === 3 && field.wire === 2
          ? bytesField(3, addLabels(field.value))
          : field.raw,
      ),
    );
  } catch (cause) {
    throw new AppError(
      "USER_INPUT",
      "地图源返回无效矢量名称数据，请重试或更换底图",
      { cause },
    );
  }
}
