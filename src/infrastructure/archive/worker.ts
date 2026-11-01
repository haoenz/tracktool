import type { MediaTime } from "../../domain/media-time.js";
import { ArchiveWriter } from "./writer.js";
import type { ArchiveRequest } from "../../domain/archive.js";
import { parentPort } from "node:worker_threads";
import { ArchiveStore } from "./store.js";
import { errorInfo } from "../../domain/errors.js";
import { xmlStats } from "../xml/document.js";
import {
  databaseStats,
  enableSharedConnections,
  resetSharedConnections,
} from "./database.js";
// One message at a time: a single connection serves the whole worker.
enableSharedConnections();
const store = new ArchiveStore();
const writer = new ArchiveWriter();
const exportsInProgress = new Map<number, AbortController>();
parentPort!.on(
  "message",
  async (m: {
    id: number;
    op: string;
    time?: MediaTime;
    multiday?: boolean;
    tolerance?: number;
    request?: ArchiveRequest;
    path: string;
    entries?: string[];
    name?: string;
    sha256?: string;
  }) => {
    if (m.op === "cancel-export") {
      exportsInProgress.get(m.id)?.abort();
      return;
    }
    const controller =
      m.op === "write" && m.request?.kind === "backup"
        ? new AbortController()
        : undefined;
    if (controller) exportsInProgress.set(m.id, controller);
    try {
      let result: unknown;
      switch (m.op) {
        case "bytes":
          result = store.readBytes(m.path, m.name!);
          break;
        case "raw":
          result = store.readObject(m.path, m.sha256!);
          break;
        case "track-data":
          result = await store.readTrackData(m.path, m.name!);
          break;
        case "write":
          result = await writer.execute(m.request!, controller?.signal);
          break;
        case "nearest":
          result = await store.nearest(
            m.path,
            m.time!,
            m.multiday!,
            m.tolerance!,
          );
          break;
        case "catalog":
          result = store.catalog(m.path);
          break;
        case "stats":
          result = {
            ...store.stats,
            parses: xmlStats.parses,
            opens: databaseStats.opens,
          };
          break;
        default:
          throw new Error("Unknown archive operation");
      }
      parentPort!.postMessage({ id: m.id, result });
    } catch (error) {
      parentPort!.postMessage({ id: m.id, error: errorInfo(error) });
    } finally {
      exportsInProgress.delete(m.id);
      // Restores and inits may replace the database file under the session.
      if (m.op === "write") resetSharedConnections();
    }
  },
);
