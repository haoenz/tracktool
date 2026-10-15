import type { MediaTime } from "../../domain/media-time.js";
import { ArchiveWriter } from "./writer.js";
import type { ArchiveRequest } from "../../domain/archive.js";
import { parentPort } from "node:worker_threads";
import { ArchiveStore } from "./store.js";
import { errorInfo } from "../../domain/errors.js";
import type { Project } from "../../shared/project.js";
import type { ProjectTrack } from "../../shared/project-track.js";
const store = new ArchiveStore();
const writer = new ArchiveWriter();
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
    expected?: Record<string, string>;
    references?: ProjectTrack[];
    name?: string;
    state?: Project;
  }) => {
    try {
      let result: unknown;
      switch (m.op) {
        case "display-kml":
          result = store.displayKml(m.path, m.references!);
          break;
        case "current-reference":
          result = store.currentReference(m.path, m.name!);
          break;
        case "bytes":
          result = store.readBytes(m.path, m.name!);
          break;
        case "track-data":
          result = await store.readTrackData(m.path, m.name!);
          break;
        case "write":
          result = await writer.execute(m.request!);
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
        case "selection":
          result = await store.selection(
            m.path,
            m.entries!,
            m.expected,
            m.references,
          );
          break;
        case "projects":
          result = store.projects(m.path);
          break;
        case "load":
          result = store.load(m.path, m.name!);
          break;
        case "save":
          result = store.save(m.path, m.name!, m.state!);
          break;
        case "stats":
          result = store.stats;
          break;
        default:
          throw new Error("Unknown archive operation");
      }
      parentPort!.postMessage({ id: m.id, result });
    } catch (error) {
      parentPort!.postMessage({ id: m.id, error: errorInfo(error) });
    }
  },
);
