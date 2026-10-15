import { XmlElement } from "libxml2-wasm";
import { withDocument, namespaces } from "./document.js";
import { readTrackData } from "./trackdata.js";
import type { Manifest, SegmentManifest } from "../../domain/track-version.js";
import { displayMetadata } from "./display-metadata.js";

/** Never rewrites XML. Element-only child offsets are independent of formatting. */
export function readManifest(
  bytes: Uint8Array,
  segmentId: (ordinal: number) => string,
): Manifest {
  try {
    return withDocument(bytes, (doc) => {
      const tracks = readTrackData(doc).tracks.flatMap((t) => t.segments);
      const ns = { ...namespaces, kml: doc.root.namespaceUri! };
      const metadata = displayMetadata(doc),
        generated = new Set(
          metadata.flatMap((g) =>
            g.edges.flatMap((e) => (e.line_id ? [e.line_id] : [])),
          ),
        );
      const kinds = new Map(
        metadata.flatMap((g) =>
          g.segments.map((s) => [s.xml_id, s.source_kind] as const),
        ),
      );
      const segments: SegmentManifest[] = [];
      const visit = (
        node: XmlElement,
        locator: number[],
        inPlacemark: boolean,
      ): void => {
        const inside =
          inPlacemark ||
          (node.name === "Placemark" && node.namespaceUri === ns.kml);
        const kind =
          node.namespaceUri === ns.gx && node.name === "Track"
            ? "gx:Track"
            : node.namespaceUri === ns.kml && node.name === "LineString"
              ? "LineString"
              : null;
        if (inside && kind && !generated.has(node.attr("id")?.content ?? "")) {
          const ordinal = segments.length,
            track = tracks[ordinal];
          if (!track || track.kind !== kind)
            throw new Error("Ambiguous geometry manifest");
          const count = track.longitude.length;
          const times =
            kind === "gx:Track" ? node.find("kml:when | gx:when", ns) : [];
          segments.push({
            segment_id: segmentId(ordinal),
            ordinal,
            locator,
            geometry_kind: kind,
            source_kind: kinds.get(node.attr("id")?.content ?? "") ?? "unknown",
            point_count: count,
            time_status:
              times.length === 0
                ? "absent"
                : times.length === count && times.every((n) => n.content.trim())
                  ? "present"
                  : "mismatch",
          });
        }
        node.find("./*").forEach((child, index) => {
          if (child instanceof XmlElement)
            visit(child, [...locator, index], inside);
        });
      };
      visit(doc.root, [], false);
      if (segments.length !== tracks.length)
        throw new Error("Incomplete geometry manifest");
      return { status: "ready", error: null, segments };
    });
  } catch (error) {
    return {
      status: "unavailable",
      error: error instanceof Error ? error.message : String(error),
      segments: [],
    };
  }
}
