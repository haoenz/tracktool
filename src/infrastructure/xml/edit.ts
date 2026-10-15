import { XmlElement, type XmlDocument, type XmlNode } from "libxml2-wasm";
import { withDocument, namespaces } from "./document.js";
import { AppError } from "../../domain/errors.js";
import type { Content } from "../../domain/archive.js";
import { driftIndices, editTime, splitIndices } from "../../domain/kml-edit.js";
import type { EditOperation, EditResult } from "../../domain/kml-edit.js";
const ns = (doc: XmlDocument) => ({
  ...namespaces,
  kml: doc.root.namespaceUri || namespaces.kml,
});
const elements = (nodes: XmlNode[]) =>
  nodes.filter((n): n is XmlElement => n instanceof XmlElement);
const replaceText = (node: XmlElement, text: string) => {
  while (node.firstChild) node.firstChild.remove();
  node.addText(text);
};
const directText = (node: XmlNode) => node.get("text()")?.content ?? "";
function value(doc: XmlDocument, name: string): string {
  return (
    doc.get(
      `/kml:kml/kml:Document/kml:ExtendedData/kml:Data[@name='${name}']/kml:value`,
      ns(doc),
    )?.content ?? ""
  );
}
export function readContent(doc: XmlDocument): Content {
  const namespaces = ns(doc);
  const segments: string[] = [];
  for (const placemark of doc.find("//kml:Placemark", namespaces))
    for (const geometry of elements(
      placemark.find(".//kml:LineString | .//gx:Track", namespaces),
    )) {
      const text =
        geometry.name === "Track"
          ? geometry
              .find("./gx:coord", namespaces)
              .map((n) => directText(n).trim().split(/\s+/).join(","))
              .join(" ")
              .trim()
          : directText(
              geometry.get("./kml:coordinates", namespaces) ?? geometry,
            ).trim();
      if (text) segments.push(text);
    }
  const desc = doc.get(
    "/kml:kml/kml:Document/kml:Folder/kml:Placemark/kml:description",
    namespaces,
  );
  let description =
    desc
      ?.find("./*")
      .map((n) => n.content + "\n")
      .join("") ?? "";
  for (const key of ["TrackTags", "PosStartName", "PosEndName"])
    description += `${key}:${value(doc, key)}\n`;
  if (desc) description += desc.content + "\n";
  return { tag: value(doc, "TrackTags").trim(), description, segments };
}
function track(doc: XmlDocument): XmlElement {
  const node = doc.get(
    "/kml:kml/kml:Document/kml:Folder/kml:Placemark/gx:Track",
    ns(doc),
  );
  if (!(node instanceof XmlElement))
    throw new AppError(
      "USER_INPUT",
      "No gx:Track found under Document/Folder/Placemark",
    );
  return node;
}
function series(doc: XmlDocument, parseTimes = true) {
  const node = track(doc),
    namespaces = ns(doc);
  const coords = elements(node.find("./gx:coord", namespaces));
  const whens = elements(node.find("./kml:when", namespaces));
  if (!whens.length || whens.length !== coords.length)
    throw new AppError(
      "USER_INPUT",
      "Track points must carry matching timestamps",
    );
  return {
    node,
    coords,
    whens,
    times: parseTimes ? whens.map((w) => editTime(directText(w))) : [],
  };
}
function rename(doc: XmlDocument, name: string): void {
  const node = doc.get("/kml:kml/kml:Document/kml:name", ns(doc));
  if (node instanceof XmlElement) replaceText(node, name);
}
function altitudeNodes(doc: XmlDocument) {
  const nodes = elements(doc.find("//kml:LineString/kml:coordinates", ns(doc)));
  const groups: { owner: XmlNode; nodes: XmlElement[] }[] = [];
  for (const node of nodes) {
    const owner =
      node.get("ancestor::kml:Placemark[1]", ns(doc)) ?? node.parent!;
    let group = groups.find((g) => g.owner.isSameNode(owner));
    if (!group) {
      group = { owner, nodes: [] };
      groups.push(group);
    }
    group.nodes.push(node);
  }
  const missing = (tuple: string) => {
    const a = tuple.split(",")[2];
    return a === undefined || !a.trim() || Number(a) === 0;
  };
  return groups
    .filter((g) =>
      g.nodes.every((n) =>
        directText(n).trim().split(/\s+/).filter(Boolean).every(missing),
      ),
    )
    .flatMap((g) => g.nodes)
    .filter((n) => directText(n).trim());
}
export function executeEdit(
  bytes: Uint8Array,
  operation: EditOperation,
): EditResult {
  return withDocument(bytes, (doc) => {
    const namespaces = ns(doc);
    const output = (): EditResult => ({
      outputs: [{ xml: doc.toString({ encoding: "utf-8" }) }],
    });
    switch (operation.kind) {
      case "set-tag": {
        let nodes = elements(
          doc.find(
            '/kml:kml/kml:Document/kml:ExtendedData/kml:Data[@name="TrackTags"]/kml:value',
            namespaces,
          ),
        );
        if (!nodes.length) {
          if (!operation.create)
            throw new AppError(
              "USER_INPUT",
              "TrackTags missing; use --create-tag",
            );
          const root = doc.get("/kml:kml/kml:Document", namespaces);
          if (!(root instanceof XmlElement))
            throw new AppError("USER_INPUT", "KML has no Document");
          let data = root.get("./kml:ExtendedData", namespaces);
          if (!(data instanceof XmlElement)) {
            const name = root.get("./kml:name", namespaces);
            data =
              name instanceof XmlElement
                ? name.appendElement("ExtendedData", root.namespacePrefix)
                : root.firstChild
                  ? root.firstChild.prependElement(
                      "ExtendedData",
                      root.namespacePrefix,
                    )
                  : root.addElement("ExtendedData", root.namespacePrefix);
          }
          const tag = (data as XmlElement).addElement(
            "Data",
            root.namespacePrefix,
          );
          tag.setAttr("name", "TrackTags");
          nodes = [tag.addElement("value", root.namespacePrefix)];
        }
        for (const node of nodes) replaceText(node, operation.tag);
        return output();
      }
      case "split": {
        const { coords, whens, times } = series(doc);
        const texts = coords.map(directText),
          whenTexts = whens.map(directText);
        const boundaries = splitIndices(texts, times, operation);
        if (!boundaries.length)
          return { outputs: [], warnings: ["No recording gaps found"] };
        let start = 0;
        const outputs: EditResult["outputs"] = [];
        for (const [i, end] of [...boundaries, coords.length - 1].entries()) {
          const name = (
            operation.stem.includes("-Splited")
              ? `${operation.stem}-${i + 1}`
              : `${operation.stem}-Splited-${i + 1}`
          ).replaceAll(":", "");
          const xml = withDocument(bytes, (copy) => {
            const old = track(copy);
            if (
              old.parent?.namespaceForPrefix(old.namespacePrefix) !==
              namespaces.gx
            )
              old.parent!.addNsDeclaration(namespaces.gx, old.namespacePrefix);
            const fresh = old.appendElement("Track", old.namespacePrefix);
            old.remove();
            // Keep the legacy order: all coordinates, then matching timestamps.
            for (let j = start; j <= end; j++)
              fresh
                .addElement("coord", fresh.namespacePrefix)
                .addText(texts[j]!);
            const kmlPrefix = copy.root.namespacePrefix;
            for (let j = start; j <= end; j++)
              fresh.addElement("when", kmlPrefix).addText(whenTexts[j]!);
            rename(copy, name);
            return copy.toString({ encoding: "utf-8" });
          });
          outputs.push({ name: `${name}.kml`, xml });
          start = end + 1;
        }
        return { outputs, count: outputs.length };
      }
      case "prune": {
        const { coords, whens, times } = series(doc, operation.auto);
        let remove: Set<number>;
        if (operation.auto)
          remove = driftIndices(coords.map(directText), times, operation);
        else {
          if (operation.points.length < 1 || operation.points.length > 2)
            throw new AppError(
              "USER_INPUT",
              "Prune requires one or two points",
            );
          const indices = operation.points.map((p) => {
            let i = whens.findIndex((w) => directText(w) === p);
            if (i < 0) i = coords.findIndex((c) => directText(c) === p);
            return i;
          });
          if (indices.includes(-1))
            return { outputs: [], warnings: ["Location not found in track"] };
          const first = Math.min(...indices),
            last = Math.max(...indices);
          remove = new Set(
            Array.from({ length: last - first + 1 }, (_, i) => first + i),
          );
        }
        if (!remove.size)
          return { outputs: [], count: 0, warnings: ["No drift points found"] };
        for (const i of remove) {
          coords[i]!.remove();
          whens[i]!.remove();
        }
        const name = `${operation.stem}-Fixed`.replaceAll(":", "");
        rename(doc, name);
        return {
          outputs: [
            { name: `${name}.kml`, xml: doc.toString({ encoding: "utf-8" }) },
          ],
          count: remove.size,
        };
      }
      case "altitude-targets":
      case "altitude-apply": {
        const nodes = altitudeNodes(doc);
        const locations: [number, number][] = [];
        for (const n of nodes)
          for (const t of directText(n).trim().split(/\s+/)) {
            const parts = t.split(",");
            const lon = Number(parts[0]),
              lat = Number(parts[1]);
            if (
              parts.length < 2 ||
              !Number.isFinite(lon) ||
              !Number.isFinite(lat) ||
              Math.abs(lon) > 180 ||
              Math.abs(lat) > 90
            )
              throw new AppError("USER_INPUT", `Invalid coordinate: ${t}`);
            locations.push([lat, lon]);
          }
        if (operation.kind === "altitude-targets")
          return { outputs: [], locations };
        if (operation.values.length !== locations.length)
          throw new AppError("TOOL", "Elevation response length mismatch");
        let i = 0;
        for (const node of nodes)
          replaceText(
            node,
            directText(node)
              .trim()
              .split(/\s+/)
              .map((tuple) => {
                const parts = tuple.split(",");
                return `${parts[0]},${parts[1]},${operation.values[i++] ?? 0}`;
              })
              .join(" "),
          );
        return nodes.length
          ? { ...output(), count: i }
          : { outputs: [], count: 0 };
      }
    }
    throw new AppError("USER_INPUT", "Unsupported or retired XML operation");
  });
}
