import { executeEdit, readContent } from "./edit.js";
import { editSegments } from "./segment-edit.js";
import { parentPort, workerData } from "node:worker_threads";
import { readTrackData } from "./trackdata.js";
import { pointCount } from "../../domain/trackdata.js";
import { executeXml, withDocument } from "./document.js";
import { errorInfo } from "../../domain/errors.js";
import type { XmlOperation } from "../../services/ports.js";

const { bytes, operation } = workerData as {
  bytes: Uint8Array;
  operation: XmlOperation;
};
// Let the ESM initialization promise settle before posting results. A caller can
// dispose the worker immediately after receiving a message.
setImmediate(() => {
  try {
    if (operation.kind === "tracks") {
      const data = withDocument(bytes, (doc) =>
        readTrackData(doc, operation.source),
      );
      const buffers = data.tracks.flatMap((t) =>
        t.segments.flatMap((s) =>
          [s.longitude, s.latitude, s.altitude, s.time_us]
            .filter((v) => v !== null)
            .map((v) => v.buffer as ArrayBuffer),
        ),
      );
      parentPort?.postMessage(
        {
          result: {
            name: data.name,
            placemarks: data.tracks.length,
            coordinateNodes: pointCount(data),
            tracks: data,
          },
        },
        buffers,
      );
    } else if (operation.kind === "segment-edit") {
      parentPort?.postMessage({
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
      });
    } else if (operation.kind === "content" || operation.kind === "edit") {
      parentPort?.postMessage({
        result: {
          name: "",
          placemarks: 0,
          coordinateNodes: 0,
          ...(operation.kind === "content"
            ? { content: withDocument(bytes, readContent) }
            : { edit: executeEdit(bytes, operation.operation) }),
        },
      });
    } else parentPort?.postMessage({ result: executeXml(bytes, operation) });
  } catch (error) {
    parentPort?.postMessage({ error: errorInfo(error) });
  } finally {
    parentPort?.close();
  }
});
