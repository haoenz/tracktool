import { XmlElement, type XmlDocument } from "libxml2-wasm";
import { AppError } from "../../domain/errors.js";
import {
  coordinateNumber,
  timestamp,
  MAX_POINTS,
} from "../../domain/trackdata.js";
import type { TrackData, TrackSegment } from "../../domain/trackdata.js";
import { namespaces, xpathLiteral } from "./document.js";
import { displayMetadata } from "./display-metadata.js";

const text = (node: { content: string } | null) => node?.content.trim() ?? "";
export function readTrackData(doc: XmlDocument, source = ""): TrackData {
  const uri = doc.root.namespaceUri;
  if (!uri)
    throw new AppError("USER_INPUT", "Expected a namespaced KML document");
  const ns = { ...namespaces, kml: uri };
  const metadata = displayMetadata(doc),
    generated = new Set(
      metadata.flatMap((g) =>
        g.edges.flatMap((e) => (e.line_id ? [e.line_id] : [])),
      ),
    );
  const value = (name: string) =>
    text(
      doc.get(
        `/kml:kml/kml:Document/kml:ExtendedData/kml:Data[@name=${xpathLiteral(name)}]/kml:value`,
        ns,
      ),
    );
  const result: TrackData = {
    source,
    name: text(doc.get("/kml:kml/kml:Document/kml:name", ns)),
    track_tags: value("TrackTags"),
    start_name: value("PosStartName"),
    end_name: value("PosEndName"),
    tracks: [],
  };
  const placemarks = doc.find("//kml:Placemark", ns);
  let totalPoints = 0;
  for (const [i, placemark] of placemarks.entries()) {
    if (!(placemark instanceof XmlElement)) continue;
    const name = text(placemark.get("kml:name", ns)),
      segments: TrackSegment[] = [];
    for (const element of placemark.find(
      ".//gx:Track | .//kml:LineString",
      ns,
    )) {
      if (!(element instanceof XmlElement)) continue;
      if (generated.has(element.attr("id")?.content ?? "")) continue;
      const gx = element.namespaceUri === ns.gx;
      const location = `${source || "<XML>"}: Placemark ${i + 1} (${name}), segment ${segments.length + 1}`;
      const coordinates = element.find(gx ? "gx:coord" : "kml:coordinates", ns);
      if (gx && totalPoints + coordinates.length > MAX_POINTS)
        throw new AppError("USER_INPUT", "KML exceeds 2,000,000 points");
      if (!gx && coordinates.length !== 1)
        throw new AppError(
          "USER_INPUT",
          `${location}: Expected exactly one coordinates element`,
        );
      const texts: Iterable<string> = gx
        ? (function* () {
            for (const n of coordinates) yield text(n);
          })()
        : (function* () {
            for (const m of text(coordinates[0]!).matchAll(/\S+/g)) yield m[0];
          })();
      let capacity = gx ? coordinates.length : 1024,
        count = 0;
      let lon = new Float64Array(capacity),
        lat = new Float64Array(capacity),
        alt: Float64Array | null = null;
      for (const point of texts) {
        if (++totalPoints > MAX_POINTS)
          throw new AppError("USER_INPUT", "KML exceeds 2,000,000 points");
        if (count === capacity) {
          capacity = Math.max(1, capacity * 2);
          const a = new Float64Array(capacity),
            b = new Float64Array(capacity);
          a.set(lon);
          b.set(lat);
          lon = a;
          lat = b;
          if (alt) {
            const c = new Float64Array(capacity).fill(NaN);
            c.set(alt);
            alt = c;
          }
        }
        const parts = gx ? point.split(/\s+/) : point.split(",");
        if (parts.length < 2 || parts.length > 3 || parts.some((p) => !p))
          throw new AppError(
            "USER_INPUT",
            `${location}, point ${count + 1}: Malformed coordinate`,
          );
        lon[count] = coordinateNumber(
          parts[0]!,
          "longitude",
          `${location}, point ${count + 1}`,
        );
        lat[count] = coordinateNumber(
          parts[1]!,
          "latitude",
          `${location}, point ${count + 1}`,
        );
        if (parts.length === 3) {
          alt ??= new Float64Array(capacity).fill(NaN);
          alt[count] = coordinateNumber(
            parts[2]!,
            "altitude",
            `${location}, point ${count + 1}`,
          );
        }
        count++;
      }
      if (!count)
        throw new AppError(
          "USER_INPUT",
          `${location}: Empty line geometry; no coordinates`,
        );
      let time: BigInt64Array | null = null;
      if (gx) {
        const times = element.find("kml:when | gx:when", ns);
        if (times.length && times.length === count) {
          time = new BigInt64Array(count);
          let missing = false;
          times.forEach((n, j) => {
            const value = text(n);
            if (value)
              time![j] = timestamp(value, `${location}, point ${j + 1}`);
            else missing = true;
          });
          if (missing) time = null;
        }
      }
      segments.push({
        kind: gx ? "gx:Track" : "LineString",
        geometry_id: element.attr("id")?.content ?? "",
        longitude: count === capacity ? lon : lon.slice(0, count),
        latitude: count === capacity ? lat : lat.slice(0, count),
        altitude: alt ? (count === capacity ? alt : alt.slice(0, count)) : null,
        time_us: time,
      });
    }
    if (segments.length)
      result.tracks.push({
        index: i + 1,
        placemark_id: placemark.attr("id")?.content ?? "",
        name,
        segments,
      });
  }
  if (!result.tracks.length && !metadata.length)
    throw new AppError(
      "USER_INPUT",
      `${source || "<XML>"}: No extractable line tracks (gx:Track or LineString)`,
    );
  return result;
}
