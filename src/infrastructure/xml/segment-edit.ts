import { randomUUID } from "node:crypto";
import { XmlElement, type XmlDocument, type XmlNode } from "libxml2-wasm";
import { AppError } from "../../domain/errors.js";
import {
  checkedEdit,
  keptRanges,
  insertSettings,
  splitSettings,
  type PointRange,
  type SegmentEditResult,
  type SegmentInput,
  type SegmentLineage,
} from "../../domain/segment-edit.js";
import {
  validatePresentation,
  type SegmentManifest,
} from "../../domain/track-version.js";
import { MAX_KML_BYTES, MAX_POINTS } from "../../domain/trackdata.js";
import { xmlText, kmlRoot } from "../../domain/kml-edit.js";
import { bindSegments, resolvedEdges } from "../../domain/presentation.js";
import { stableId } from "../archive/identity.js";
import { withDocument, namespaces } from "./document.js";
import { readManifest } from "./manifest.js";
import { readTrackData } from "./trackdata.js";
import { displayMetadata, stripDisplay } from "./display-metadata.js";

const elements = (nodes: XmlNode[]) =>
  nodes.filter((n): n is XmlElement => n instanceof XmlElement);
const ns = (doc: XmlDocument) => ({
  ...namespaces,
  kml: doc.root.namespaceUri || namespaces.kml,
});
const fail = (message: string): never => {
  throw new AppError("USER_INPUT", message);
};
const bytes = (xml: string) => new TextEncoder().encode(xml);
const canonical = (node: XmlNode) =>
  node.canonicalizeToString({ withComments: true });
const token = () => `tracktool-${randomUUID()}`;
function replaceText(node: XmlElement, text: string) {
  while (node.firstChild) node.firstChild.remove();
  node.addText(text);
}
export function locateSegment(
  doc: XmlDocument,
  s: SegmentManifest,
): XmlElement {
  let node = doc.root;
  for (const index of s.locator) {
    const next = elements(node.find("./*"))[index];
    if (!next) fail("Stale segment locator");
    node = next!;
  }
  const kind =
    node.namespaceUri === namespaces.gx && node.name === "Track"
      ? "gx:Track"
      : node.namespaceUri === doc.root.namespaceUri &&
          node.name === "LineString"
        ? "LineString"
        : null;
  if (kind !== s.geometry_kind)
    fail("Segment locator points to a different geometry");
  return node;
}
/** Patches are inserted as unique comments, then replaced once after XML serialization. */
function patch(node: XmlElement, replacement: string) {
  const mark = token();
  node.prependComment(mark);
  node.remove();
  return { mark: `<!--${mark}-->`, replacement };
}
function render(
  doc: XmlDocument,
  patches: { mark: string; replacement: string }[],
) {
  let xml = doc.toString({ encoding: "utf-8" });
  for (const p of patches) {
    if (xml.split(p.mark).length !== 2) fail("Ambiguous XML patch");
    xml = xml.replace(p.mark, () => p.replacement);
  }
  const raw = bytes(xml);
  if (raw.length > MAX_KML_BYTES) fail("Edited KML exceeds 128 MiB");
  return raw;
}

/** Extract aligned XML samples once: splitting many times does not repeatedly parse the whole track. */
function sampleTemplate(node: XmlElement, count: number) {
  return withDocument(bytes(canonical(node)), (doc) => {
    const root = doc.root,
      namespacesForNode = { ...namespaces, kml: node.doc.root.namespaceUri };
    const replacements: {
      mark: string;
      values: string[];
      separator: string;
    }[] = [];
    const group = (nodes: XmlElement[], label: string) => {
      if (!nodes.length) return;
      if (nodes.length !== count)
        fail(
          `${label} must have one value per point; refusing ambiguous sample alignment`,
        );
      const mark = token(),
        values = nodes.map((n) => n.toString());
      nodes[0]!.prependComment(mark);
      nodes.forEach((n) => n.remove());
      replacements.push({ mark: `<!--${mark}-->`, values, separator: "" });
    };
    // Unknown repeated extension elements might be sample arrays. Never silently retain misaligned rows.
    for (const parent of [root, ...elements(root.find(".//*"))]) {
      const seen = new Set<string>();
      for (const child of elements(parent.find("./*"))) {
        if ([namespacesForNode.kml, namespaces.gx].includes(child.namespaceUri))
          continue;
        const key = JSON.stringify([child.namespaceUri, child.name]);
        if (seen.has(key))
          fail(
            "Unsupported repeated extension array; explicit sample mapping is required",
          );
        seen.add(key);
      }
    }
    if (root.name === "Track" && root.namespaceUri === namespaces.gx) {
      group(elements(root.find("./gx:coord", namespacesForNode)), "gx:coord");
      group(
        elements(root.find("./kml:when | ./gx:when", namespacesForNode)),
        "when",
      );
      group(elements(root.find("./gx:angles", namespacesForNode)), "gx:angles");
    } else {
      const coords = root.get("./kml:coordinates", namespacesForNode);
      if (!(coords instanceof XmlElement))
        fail("LineString coordinates missing");
      const values = coords!.content.trim().split(/\s+/);
      if (values.length !== count) fail("Point count differs from manifest");
      const mark = token();
      replaceText(coords as XmlElement, mark);
      replacements.push({ mark, values, separator: " " });
    }
    for (const array of root.find(".//gx:SimpleArrayData", namespacesForNode))
      group(
        elements(array.find("./gx:value", namespacesForNode)),
        "gx:SimpleArrayData",
      );
    const idMark = token(),
      oldId = root.attr("id")?.content;
    root.attr("id")?.remove();
    root.setAttr("id", idMark);
    const nestedIds = new Map<string, string>();
    for (const element of elements(root.find(".//*[@id]"))) {
      const attr = element.attr("id")!;
      const mark = token();
      if (nestedIds.has(attr.content))
        fail("Duplicate nested XML IDs cannot be split safely");
      nestedIds.set(attr.content, mark);
      attr.content = mark;
    }
    const references = oldId
      ? new Map([...nestedIds, [oldId, idMark]])
      : nestedIds;
    for (const element of [root, ...elements(root.find(".//*"))]) {
      for (const attr of element.attrs) {
        const value = attr.content;
        if (
          attr.name !== "id" &&
          value.startsWith("#") &&
          references.has(value.slice(1))
        )
          attr.content = "#" + references.get(value.slice(1))!;
        else if (attr.name === "targetId" && references.has(value))
          attr.content = references.get(value)!;
      }
      if (
        ["styleUrl", "href"].includes(element.name) &&
        element.namespaceUri === namespacesForNode.kml
      ) {
        const value = element.content.trim();
        if (value.startsWith("#") && references.has(value.slice(1)))
          replaceText(element, "#" + references.get(value.slice(1))!);
      }
    }
    const template = root.toString();
    return (ranges: PointRange[], reverse = false, newId?: string) => {
      let xml = template;
      for (const r of replacements) {
        let values = ranges.flatMap((range) =>
          r.values.slice(range.start, range.end),
        );
        if (reverse) values = values.reverse();
        xml = xml.replace(r.mark, () => values.join(r.separator));
      }
      if (newId || oldId)
        xml = xml.replaceAll(idMark, () => xmlText(newId ?? oldId!));
      else xml = xml.replace(` id="${idMark}"`, "");
      for (const [original, mark] of nestedIds)
        xml = xml.replaceAll(mark, () =>
          xmlText(newId ? `${newId}-${original}` : original),
        );
      return xml;
    };
  });
}
function lineage(
  input: SegmentInput,
  s: SegmentManifest,
  ordinal: number,
  ranges: PointRange[] = [{ start: 0, end: s.point_count }],
  reverse = false,
): SegmentLineage[] {
  return ranges.map((r) => ({
    ordinal,
    source_version_id: input.version_id,
    source_segment_id: s.segment_id,
    start: r.start,
    end_exclusive: r.end,
    evidence_kind: reverse ? "manual" : "exact",
    evidence: { reversed: reverse },
  }));
}
function validateInput(input: SegmentInput) {
  if (input.raw.length > MAX_KML_BYTES) fail("KML exceeds 128 MiB");
  const manifest = readManifest(
    input.raw,
    (i) => input.segments[i]?.segment_id ?? "missing",
  );
  if (
    manifest.status !== "ready" ||
    manifest.segments.length !== input.segments.length
  )
    fail(`KML is not editable: ${manifest.error ?? "manifest mismatch"}`);
  for (const [i, s] of manifest.segments.entries()) {
    const expected = input.segments[i]!;
    if (
      s.ordinal !== expected.ordinal ||
      s.geometry_kind !== expected.geometry_kind ||
      s.point_count !== expected.point_count ||
      s.time_status !== expected.time_status ||
      JSON.stringify(s.locator) !== JSON.stringify(expected.locator)
    )
      fail("Segment manifest does not match source XML");
  }
  validatePresentation(
    input.settings,
    input.segments.map((s) => s.segment_id),
  );
}
function finish(
  raw: Uint8Array,
  ids: string[],
  kinds: SegmentManifest["source_kind"][],
  settings: SegmentInput["settings"],
  sources: SegmentLineage[],
  changes: SegmentEditResult["changes"],
): SegmentEditResult {
  if (raw.length > MAX_KML_BYTES) fail("Edited KML exceeds 128 MiB");
  const manifest = readManifest(raw, (i) => ids[i] ?? "missing");
  if (
    manifest.status !== "ready" ||
    manifest.segments.length !== ids.length ||
    new Set(ids).size !== ids.length
  )
    fail(
      `Invalid edited geometry: ${manifest.error ?? "segment identity mismatch"}`,
    );
  if (manifest.segments.reduce((n, s) => n + s.point_count, 0) > MAX_POINTS)
    fail("Edited KML exceeds point limit");
  manifest.segments.forEach((s, i) => {
    s.source_kind = kinds[i]!;
  });
  changes.after_edges = resolvedEdges(settings, ids);
  return {
    raw,
    segments: manifest.segments,
    settings: validatePresentation(settings, ids),
    sources,
    changes,
  };
}

/** Core single-journey editor. Input bytes and presentation snapshots are never mutated. */
export function editSegments(
  input: SegmentInput,
  operation: unknown,
  seed: string,
  additional: SegmentInput[] = [],
): SegmentEditResult {
  const op = checkedEdit(operation);
  const clean = (source: SegmentInput): SegmentInput =>
    withDocument(source.raw, (doc) => {
      if (!displayMetadata(doc).length) return source;
      stripDisplay(doc);
      const raw = bytes(doc.toString({ encoding: "utf-8" }));
      const manifest = readManifest(raw, (i) => source.segments[i]!.segment_id);
      if (manifest.status !== "ready") fail("Cannot edit display KML");
      return {
        ...source,
        raw,
        segments: manifest.segments.map((s, i) => ({
          ...s,
          source_kind: source.segments[i]!.source_kind,
        })),
      };
    });
  // Presentation-only updates preserve exact stored bytes, including export metadata.
  if (op.kind !== "presentation") {
    input = clean(input);
    additional = additional.map(clean);
  }
  if (
    input.raw.length + additional.reduce((n, s) => n + s.raw.length, 0) >
    MAX_KML_BYTES
  )
    fail("Composition inputs exceed 128 MiB");
  validateInput(input);
  const changes: SegmentEditResult["changes"] = {
    added_points: 0,
    removed_points: 0,
    removed_ranges: [],
    removed_connections: [],
    before_edges: resolvedEdges(
      input.settings,
      input.segments.map((s) => s.segment_id),
    ),
    after_edges: [],
    warnings: [],
  };
  const ids = input.segments.map((s) => s.segment_id),
    kinds = input.segments.map((s) => s.source_kind);
  const sources = input.segments.flatMap((s, i) => lineage(input, s, i));
  if (op.kind === "presentation") {
    changes.removed_connections = input.settings.connections.filter(
      (old) =>
        !op.settings.connections.some(
          (e) =>
            e.from === old.from && e.to === old.to && e.connect === old.connect,
        ),
    );
    return finish(input.raw, ids, kinds, op.settings, sources, changes);
  }
  if (op.kind === "compose") {
    const inputs = [input, ...additional];
    if (new Set(inputs.map((s) => s.version_id)).size !== inputs.length)
      fail("Duplicate composition source version");
    additional.forEach(validateInput);
    const lookup = new Map(inputs.map((s) => [s.version_id, s]));
    const chosen = new Set<string>(),
      outIds: string[] = [],
      outKinds: SegmentManifest["source_kind"][] = [],
      outSources: SegmentLineage[] = [],
      fragments: string[] = [],
      schemas: string[] = [];
    let outputBytes = 0,
      selectedPoints = 0;
    op.segments.forEach((selection, i) => {
      const source = lookup.get(selection.version_id),
        s = source?.segments.find((s) => s.segment_id === selection.segment_id);
      if (!source || !s) fail("Unknown composition source segment");
      const key = JSON.stringify([selection.version_id, selection.segment_id]);
      if (chosen.has(key)) fail("Duplicate composition source segment");
      chosen.add(key);
      const selected = s!;
      selectedPoints += selected.point_count;
      if (selectedPoints > MAX_POINTS) fail("Composition exceeds point limit");
      const id = outIds.includes(selected.segment_id)
        ? stableId(`${seed}:compose:${i}`)
        : selected.segment_id;
      outIds.push(id);
      outKinds.push(selected.source_kind);
      outSources.push(
        ...lineage(source!, selected, i, undefined, selection.reverse),
      );
      const part = composeFragment(
        source!,
        selected,
        selection.reverse,
        `tt${stableId(`${seed}:xml:${i}`).replaceAll("-", "")}`,
        changes.warnings,
      );
      fragments.push(part.feature);
      schemas.push(...part.schemas);
      outputBytes += Buffer.byteLength(part.feature + part.schemas.join(""));
      if (outputBytes > MAX_KML_BYTES) fail("Composition exceeds 128 MiB");
    });
    changes.added_points = op.segments
      .filter((s) => s.version_id !== input.version_id)
      .reduce(
        (n, s) =>
          n +
          lookup
            .get(s.version_id)!
            .segments.find((t) => t.segment_id === s.segment_id)!.point_count,
        0,
      );
    for (const s of input.segments)
      if (!chosen.has(JSON.stringify([input.version_id, s.segment_id]))) {
        changes.removed_points += s.point_count;
        changes.removed_ranges.push({
          segment_id: s.segment_id,
          start: 0,
          end: s.point_count,
        });
      }
    changes.removed_connections = [...input.settings.connections];
    changes.warnings.push(
      "Composition uses the explicitly selected segment order and fresh presentation settings; source defaults are not inferred",
    );
    return finish(
      bytes(
        kmlRoot(
          `<Document>${schemas.join("")}${fragments.join("")}</Document>`,
        ),
      ),
      outIds,
      outKinds,
      {
        schema: 1,
        default_connect: op.default_connect,
        order: outIds,
        ignored: [],
        connections: [],
      },
      outSources,
      changes,
    );
  }
  return withDocument(input.raw, (doc) => {
    const nodes = input.segments.map((s) => locateSegment(doc, s));
    let settings = structuredClone(input.settings);
    const patches: { mark: string; replacement: string }[] = [];
    if (op.kind === "draw") {
      const coordinates = op.coordinates.map((p) => [...p]);
      const data = bindSegments(readTrackData(doc), input.segments);
      for (const [end, snap] of [
        [0, op.snap_start],
        [coordinates.length - 1, op.snap_end],
      ] as const) {
        if (!snap) continue;
        const target = data.find((s) => s.segment_id === snap.segment_id);
        if (!target) fail("Unknown snap segment");
        const i = snap.endpoint === "start" ? 0 : target!.longitude.length - 1,
          alt = target!.altitude?.[i];
        coordinates[end] = [target!.longitude[i]!, target!.latitude[i]!];
        if (alt !== undefined && Number.isFinite(alt))
          coordinates[end]!.push(alt);
        sources.push({
          ordinal: ids.length,
          source_version_id: input.version_id,
          source_segment_id: snap.segment_id,
          start: i,
          end_exclusive: i + 1,
          evidence_kind: "manual",
          evidence: { snap_endpoint: end },
        });
      }
      const id = stableId(`${seed}:draw`),
        inserted = insertSettings(settings, op.after_segment_id, id);
      settings = inserted.settings;
      changes.removed_connections = inserted.removed;
      const kmlNs = ns(doc).kml,
        feature = `<Placemark xmlns="${xmlText(kmlNs)}"><name>补绘</name><LineString><coordinates>${coordinates.map((p) => p.join(",")).join(" ")}</coordinates></LineString></Placemark>`;
      appendFeature(doc, feature, patches);
      ids.push(id);
      kinds.push("hand_drawn");
      changes.added_points = coordinates.length;
    } else {
      const at = ids.indexOf(op.segment_id);
      if (at < 0) fail("Unknown segment ID");
      const s = input.segments[at]!,
        node = nodes[at]!,
        select = sampleTemplate(node, s.point_count);
      if (op.kind === "split_segment") {
        const cuts = [...op.after_point_indices].sort((a, b) => a - b);
        if (
          new Set(cuts).size !== cuts.length ||
          cuts.at(-1)! >= s.point_count - 1
        )
          fail("Split boundaries must be unique and precede the last point");
        let start = 0;
        const ranges = [...cuts.map((i) => i + 1), s.point_count].map((end) => {
          const r = { start, end };
          start = end;
          return r;
        });
        const children = ranges.map((_, i) =>
          stableId(`${seed}:split:${s.segment_id}:${i}`),
        );
        const fragments = ranges.map((range, i) =>
          select([range], false, `tt-${children[i]}`),
        );
        let replacement = fragments.join("");
        const parent = node.parent!;
        if (parent.name === "Placemark" && parent.namespaceUri === ns(doc).kml)
          replacement = `<MultiGeometry xmlns="${xmlText(ns(doc).kml)}">${replacement}</MultiGeometry>`;
        else if (!(
          (parent.name === "MultiTrack" &&
            parent.namespaceUri === namespaces.gx) ||
          (parent.name === "MultiGeometry" &&
            parent.namespaceUri === ns(doc).kml)
        ))
          fail("Unsupported geometry container for internal split");
        if (parent.name === "MultiTrack") {
          for (const n of elements(parent.find("./gx:interpolate", ns(doc))))
            replaceText(n, "0");
          changes.warnings.push(
            "Native MultiTrack interpolation disabled at the split container",
          );
        }
        patches.push(patch(node, replacement));
        settings = splitSettings(settings, s.segment_id, children);
        ids.splice(at, 1, ...children);
        kinds.splice(at, 1, ...children.map(() => s.source_kind));
        sources.splice(
          0,
          sources.length,
          ...input.segments.flatMap((seg, i) =>
            i === at
              ? ranges.flatMap((range, j) =>
                  lineage(input, seg, i + j, [range]),
                )
              : lineage(input, seg, i > at ? i + children.length - 1 : i),
          ),
        );
      } else {
        const reverse = op.kind === "reverse",
          ranges = reverse
            ? [{ start: 0, end: s.point_count }]
            : keptRanges(op.ranges, s.point_count);
        patches.push(patch(node, select(ranges, reverse)));
        sources.splice(
          0,
          sources.length,
          ...input.segments.flatMap((seg, i) =>
            lineage(
              input,
              seg,
              i,
              i === at ? ranges : undefined,
              i === at && reverse,
            ),
          ),
        );
        if (op.kind === "prune") {
          changes.removed_ranges = op.ranges.map((r) => ({
            segment_id: s.segment_id,
            ...r,
          }));
          changes.removed_points = op.ranges.reduce(
            (n, r) => n + r.end - r.start,
            0,
          );
        }
        if (reverse && s.time_status !== "absent")
          changes.warnings.push(
            "Timestamps reversed with their samples; no new timestamps were generated",
          );
      }
    }
    return finish(render(doc, patches), ids, kinds, settings, sources, changes);
  });
}
function appendFeature(
  doc: XmlDocument,
  feature: string,
  patches: { mark: string; replacement: string }[],
) {
  const container = elements(
    doc.root.find("./kml:Document | ./kml:Folder", ns(doc)),
  )[0];
  if (container) {
    const mark = token();
    container.addComment(mark);
    patches.push({ mark: `<!--${mark}-->`, replacement: feature });
  } else {
    const placemarks = elements(doc.root.find("./kml:Placemark", ns(doc)));
    if (placemarks.length !== 1) fail("Expected one KML root feature");
    const node = placemarks[0]!;
    patches.push(
      patch(
        node,
        `<Document xmlns="${xmlText(ns(doc).kml)}">${canonical(node)}${feature}</Document>`,
      ),
    );
  }
}
/** Preserve the selected Placemark and its ancestor metadata, schema and style definitions. */
function composeFragment(
  input: SegmentInput,
  s: SegmentManifest,
  reverse: boolean,
  prefix: string,
  warnings: string[],
) {
  return withDocument(input.raw, (doc) => {
    const namespace = ns(doc),
      selected = locateSegment(doc, s),
      ancestors: XmlElement[] = [];
    let node: XmlElement | null = selected;
    while (node) {
      ancestors.push(node);
      node = node.parent;
    }
    const patches: { mark: string; replacement: string }[] = [];
    // Work from leaves upward so references never outlive a removed parent.
    for (const other of [...input.segments].reverse()) {
      if (other.segment_id !== s.segment_id) locateSegment(doc, other).remove();
    }
    for (const feature of elements(
      doc.find("//kml:Placemark | //kml:Folder", namespace),
    ).reverse())
      if (!ancestors.some((a) => a.isSameNode(feature))) feature.remove();
    for (const container of elements(
      doc.find("//gx:MultiTrack | //kml:MultiGeometry", namespace),
    ).reverse())
      if (!container.find(".//gx:Track | .//kml:LineString", namespace).length)
        container.remove();
    if (reverse) {
      patches.push(
        patch(
          selected,
          sampleTemplate(selected, s.point_count)(
            [{ start: 0, end: s.point_count }],
            true,
          ),
        ),
      );
      if (s.time_status !== "absent")
        warnings.push("Composed segment timestamps reversed with samples");
    }
    // Resolve ID collisions between independent source documents, including StyleMap and SchemaData.
    // Duplicate external XML IDs are ambiguous; internal segment IDs alone cannot resolve style references.
    // Patch fragments must undergo the same remapping, so finalize reversal before remapping IDs.
    const rewritten = render(doc, patches);
    return withDocument(rewritten, (copy) => {
      const mapping = new Map<string, string>();
      for (const element of elements(copy.find("//*"))) {
        const id = element.attr("id")?.content;
        if (id) {
          if (mapping.has(id)) fail("Duplicate XML IDs in composition source");
          mapping.set(id, `${prefix}-${id}`);
        }
      }
      for (const element of elements(copy.find("//*"))) {
        for (const attr of element.attrs) {
          const value = attr.content;
          if (attr.name === "id" && mapping.has(value))
            attr.content = mapping.get(value)!;
          else if (attr.name === "targetId" && mapping.has(value))
            attr.content = mapping.get(value)!;
          else if (value.startsWith("#") && mapping.has(value.slice(1)))
            attr.content = "#" + mapping.get(value.slice(1))!;
        }
        if (
          element.namespaceUri === namespace.kml &&
          ["styleUrl", "href"].includes(element.name)
        ) {
          const value = element.content.trim();
          if (value.startsWith("#") && mapping.has(value.slice(1)))
            replaceText(element, "#" + mapping.get(value.slice(1))!);
        }
      }
      const schemas = elements(copy.find("//kml:Schema", namespace)).map(
        (schema) => {
          const xml = canonical(schema);
          schema.remove();
          return xml;
        },
      );
      const root = elements(
        copy.root.find(
          "./kml:Document | ./kml:Folder | ./kml:Placemark",
          namespace,
        ),
      )[0];
      if (!root) fail("Composition source has no root feature");
      let feature = canonical(root!);
      if (root!.name === "Document" && root!.namespaceUri === namespace.kml) {
        const name = root!.namespacePrefix ? `${root!.namespacePrefix}:` : "";
        feature = feature
          .replace(`<${name}Document`, `<${name}Folder`)
          .replace(new RegExp(`</${name}Document>$`), `</${name}Folder>`);
      }
      return { feature, schemas };
    });
  });
}
