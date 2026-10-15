import { XmlElement, type XmlDocument } from "libxml2-wasm";
import { z } from "zod";
import { AppError } from "../../domain/errors.js";
export const DISPLAY_NS = "urn:tracktool:display:1";
const id = z.string().min(1).max(200);
export const DisplayMetadata = z
  .object({
    schema: z.literal(1),
    segments: z
      .array(
        z.object({
          xml_id: id,
          source_kind: z.enum(["measured", "hand_drawn", "unknown"]),
        }),
      )
      .max(10000),
    edges: z
      .array(z.object({ from: id, to: id, line_id: id.optional() }))
      .max(20000),
  })
  .strict();
export type DisplayMetadata = z.infer<typeof DisplayMetadata>;
export function displayMetadata(doc: XmlDocument): DisplayMetadata[] {
  const groups = doc.find("//tt:display", { tt: DISPLAY_NS }).map((node) => {
    try {
      return DisplayMetadata.parse(JSON.parse(node.content));
    } catch (cause) {
      throw new AppError("USER_INPUT", "展示 KML 元数据无效", { cause });
    }
  });
  if (!groups.length) return groups;
  const byId = new Map<string, XmlElement[]>();
  for (const node of doc.find("//*[@id]"))
    if (node instanceof XmlElement) {
      const key = node.attr("id")!.content;
      byId.set(key, [...(byId.get(key) ?? []), node]);
    }
  const seen = new Set<string>();
  for (const group of groups) {
    const ids = group.segments.map((s) => s.xml_id);
    const positions = new Map(ids.map((id, i) => [id, i]));
    for (const key of [
      ...ids,
      ...group.edges.flatMap((e) => (e.line_id ? [e.line_id] : [])),
    ]) {
      if (seen.has(key)) throw new AppError("USER_INPUT", "展示 KML 身份重复");
      seen.add(key);
      const nodes = byId.get(key) ?? [];
      if (
        nodes.length !== 1 ||
        !(nodes[0] instanceof XmlElement) ||
        !["Track", "LineString"].includes(nodes[0].name)
      )
        throw new AppError("USER_INPUT", "展示 KML 引用的几何缺失或不唯一");
    }
    const edges = new Set<string>();
    for (const e of group.edges) {
      const key = JSON.stringify([e.from, e.to]);
      if (
        !positions.has(e.from) ||
        !positions.has(e.to) ||
        positions.get(e.to)! <= positions.get(e.from)! ||
        edges.has(key)
      )
        throw new AppError("USER_INPUT", "展示 KML 连接无效");
      edges.add(key);
    }
  }
  return groups;
}
export function stripDisplay(doc: XmlDocument, groups = displayMetadata(doc)) {
  const generated = new Set(
    groups.flatMap((g) =>
      g.edges.flatMap((e) => (e.line_id ? [e.line_id] : [])),
    ),
  );
  for (const node of doc.find("//*[@id]").reverse())
    if (node instanceof XmlElement && generated.has(node.attr("id")!.content)) {
      if (node.parent?.name === "Placemark") node.parent.remove();
      else node.remove();
    }
  for (const node of doc.find("//tt:display", { tt: DISPLAY_NS }))
    node.remove();
}
