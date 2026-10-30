import { importLine } from "./import-line.js";
import { analyzeTrack } from "../../domain/track-analysis.js";
import { executeEdit, readContent } from "./edit.js";
import { editSegments } from "./segment-edit.js";
import { parentPort } from "node:worker_threads";
import { readTrackData } from "./trackdata.js";
import { pointCount } from "../../domain/trackdata.js";
import { executeXml, withDocument } from "./document.js";
import { errorInfo } from "../../domain/errors.js";
import type { XmlOperation } from "../../services/ports.js";

type Job = { id: number; bytes: Uint8Array; operation: XmlOperation };
type Reply = {
  id: number;
  result?: unknown;
  error?: ReturnType<typeof errorInfo>;
};

function run(
  bytes: Uint8Array,
  operation: XmlOperation,
): {
  result: unknown;
  transfer?: ArrayBuffer[];
} {
  if (operation.kind === "analysis") {
    const data = withDocument(bytes, (doc) => readTrackData(doc));
    return {
      result: {
        name: data.name,
        placemarks: data.tracks.length,
        coordinateNodes: pointCount(data),
        analysis: analyzeTrack(data, operation.params),
      },
    };
  }
  if (operation.kind === "tracks") {
    const data = withDocument(bytes, (doc) =>
      readTrackData(doc, operation.source),
    );
    const buffers = data.tracks.flatMap((track) =>
      track.segments.flatMap((segment) =>
        [segment.longitude, segment.latitude, segment.altitude, segment.time_us]
          .filter((value) => value !== null)
          .map((value) => value.buffer as ArrayBuffer),
      ),
    );
    return {
      result: {
        name: data.name,
        placemarks: data.tracks.length,
        coordinateNodes: pointCount(data),
        tracks: data,
      },
      transfer: buffers,
    };
  }
  if (operation.kind === "import-line")
    return {
      result: {
        name: "",
        placemarks: 1,
        coordinateNodes: 1,
        imported_line: importLine(bytes),
      },
    };
  if (operation.kind === "segment-edit")
    return {
      result: {
        name: "",
        placemarks: 0,
        coordinateNodes: 0,
        segment_edit: editSegments(
          { ...operation.input, raw: bytes },
          operation.operation,
          operation.seed,
          operation.additional,
        ),
      },
    };
  if (operation.kind === "content" || operation.kind === "edit")
    return {
      result: {
        name: "",
        placemarks: 0,
        coordinateNodes: 0,
        ...(operation.kind === "content"
          ? { content: withDocument(bytes, readContent) }
          : { edit: executeEdit(bytes, operation.operation) }),
      },
    };
  return { result: executeXml(bytes, operation) };
}

// A long-lived worker: parsing state is per message, so the thread and its
// libxml2 wasm instance are shared across jobs instead of re-created each time.
parentPort?.on("message", (job: Job) => {
  const reply: Reply = { id: job.id };
  let transfer: ArrayBuffer[] | undefined;
  try {
    const value = run(job.bytes, job.operation);
    reply.result = value.result;
    transfer = value.transfer;
  } catch (error) {
    reply.error = errorInfo(error);
  }
  parentPort?.postMessage(reply, transfer ?? []);
});
