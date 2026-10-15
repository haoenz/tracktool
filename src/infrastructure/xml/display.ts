import { randomUUID, createHash } from "node:crypto";
import { XmlElement } from "libxml2-wasm";
import { AppError } from "../../domain/errors.js";
import {
  bindSegments,
  evaluatePresentation,
} from "../../domain/presentation.js";
import {
  validatePresentation,
  type Presentation,
  type SegmentManifest,
} from "../../domain/track-version.js";
import type { SegmentInput } from "../../domain/segment-edit.js";
import { xmlText } from "../../domain/kml-edit.js";
import { withDocument, namespaces } from "./document.js";
import { readTrackData } from "./trackdata.js";
import {
  DISPLAY_NS,
  displayMetadata,
  stripDisplay,
  type DisplayMetadata,
} from "./display-metadata.js";

function locate(root: XmlElement, path: number[]) {
  let node = root;
  for (const i of path) {
    const child = node.find("./*")[i];
    if (!(child instanceof XmlElement))
      throw new AppError("USER_INPUT", "段定位失效");
    node = child;
  }
  return node;
}
/** Keep samples, timestamps, altitude, style definitions and extension data intact. */
export function displayKml(input: SegmentInput): Uint8Array {
  return withDocument(input.raw, (doc) => {
    const view = evaluatePresentation(
      bindSegments(readTrackData(doc), input.segments),
      input.settings,
    );
    const nodes = new Map(
      input.segments.map((s) => [s.segment_id, locate(doc.root, s.locator)]),
    );
    stripDisplay(doc);
    const visible = new Set(view.segments.map((s) => s.segment_id));
    const prefix = `tt-${createHash("sha256")
        .update(input.version_id + JSON.stringify(input.settings))
        .digest("hex")
        .slice(0, 24)}`,
      ids = new Map(
        view.segments.map((s, i) => [s.segment_id, `${prefix}-s${i}`]),
      );
    const remap = new Map<string, string>();
    for (const [id, node] of nodes) {
      if (!visible.has(id)) node.remove();
      else {
        const old = node.attr("id");
        if (old) {
          remap.set(old.content, ids.get(id)!);
          old.remove();
        }
        node.setAttr("id", ids.get(id)!);
      }
    }
    const used = new Set(ids.values());
    for (const node of doc.find("//*[@id]"))
      if (node instanceof XmlElement) {
        const attr = node.attrs.find((a) => a.name === "id")!;
        const id = attr.content;
        if (used.has(id)) continue;
        const next = `${prefix}-${id}`;
        if (remap.has(id))
          throw new AppError("USER_INPUT", "重复 XML ID 无法安全导出");
        remap.set(id, next);
        attr.content = next;
      }
    // Preserve references to the visible geometries when assigning export IDs.
    for (const node of doc.find("//*"))
      if (node instanceof XmlElement) {
        for (const attr of node.attrs) {
          if (attr.name === "targetId" && remap.has(attr.content))
            attr.content = remap.get(attr.content)!;
          else if (
            attr.content.startsWith("#") &&
            remap.has(attr.content.slice(1))
          )
            attr.content = "#" + remap.get(attr.content.slice(1))!;
        }
        if (
          ["styleUrl", "href"].includes(node.name) &&
          node.content.startsWith("#") &&
          remap.has(node.content.slice(1))
        ) {
          const v = "#" + remap.get(node.content.slice(1))!;
          while (node.firstChild) node.firstChild.remove();
          node.addText(v);
        }
      }
    const ns = { ...namespaces, kml: doc.root.namespaceUri };
    for (const n of doc.find("//gx:interpolate", ns))
      if (n instanceof XmlElement) {
        while (n.firstChild) n.firstChild.remove();
        n.addText("0");
      }
    const metadata: DisplayMetadata = {
      schema: 1,
      segments: view.segments.map((s) => ({
        xml_id: ids.get(s.segment_id)!,
        source_kind: s.source_kind,
      })),
      edges: [],
    };
    const lines: string[] = [];
    const connectionByEdge = new Map(
      view.connections.map((c) => [JSON.stringify([c.from, c.to]), c]),
    );
    for (const [i, e] of view.edges.entries()) {
      const c = connectionByEdge.get(JSON.stringify([e.from, e.to])),
        line_id = c ? `${prefix}-c${i}` : undefined;
      metadata.edges.push({
        from: ids.get(e.from)!,
        to: ids.get(e.to)!,
        ...(line_id ? { line_id } : {}),
      });
      if (c)
        lines.push(
          `<Placemark xmlns="${xmlText(ns.kml)}"><name>连接线</name><ExtendedData><Data name="tracktool:source"><value>connection</value></Data></ExtendedData><LineString id="${line_id}"><coordinates>${c.coordinates.map((p) => p.join(",")).join(" ")}</coordinates></LineString></Placemark>`,
        );
    }
    const found = doc.root.get("./kml:Document | ./kml:Folder", ns);
    const container = found instanceof XmlElement ? found : doc.root;
    const marker = `display-${randomUUID()}`;
    container.addComment(marker);
    const out = doc
      .toString({ encoding: "utf-8" })
      .replace(
        `<!--${marker}-->`,
        () =>
          lines.join("") +
          `<tt:display xmlns:tt="${DISPLAY_NS}">${xmlText(JSON.stringify(metadata))}</tt:display>`,
      );
    const bytes = Buffer.from(out);
    if (bytes.length > 128 * 1024 ** 2)
      throw new AppError("USER_INPUT", "展示导出超过 128 MiB");
    return bytes;
  });
}
/** Import uses its own segment identities and explicit edges; generated lines never become samples. */
export function importedPresentation(
  raw: Uint8Array,
  segments: SegmentManifest[],
): Presentation | undefined {
  return withDocument(raw, (doc) => {
    const groups = displayMetadata(doc);
    if (!groups.length) return;
    const byXml = new Map(
      segments.map((s) => [
        locate(doc.root, s.locator).attr("id")?.content,
        s.segment_id,
      ]),
    );
    const order = groups.flatMap((g) =>
      g.segments.map((s) => byXml.get(s.xml_id)!),
    );
    const connections = groups.flatMap((g) =>
      g.edges.map((e) => ({
        from: byXml.get(e.from)!,
        to: byXml.get(e.to)!,
        connect: true,
      })),
    );
    const imported = new Set(order);
    order.push(
      ...segments
        .filter((s) => !imported.has(s.segment_id))
        .map((s) => s.segment_id),
    );
    return validatePresentation(
      { schema: 1, default_connect: false, order, ignored: [], connections },
      segments.map((s) => s.segment_id),
    );
  });
}
