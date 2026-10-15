import type { Content } from "../domain/archive.js";
import type { EditOperation, EditResult } from "../domain/kml-edit.js";
import type { TrackData } from "../domain/trackdata.js";
import type {
  SegmentInput,
  SegmentEdit,
  SegmentEditResult,
} from "../domain/segment-edit.js";
import type { ConfigData } from "../domain/config.js";
import type { Task, TaskEvent } from "../shared/contracts.js";
export interface ConfigStore {
  load(): Promise<ConfigData>;
}
export type XmlOperation =
  | { kind: "content" }
  | { kind: "edit"; operation: EditOperation }
  | {
      kind: "segment-edit";
      input: Omit<SegmentInput, "raw">;
      operation: SegmentEdit;
      seed: string;
      additional: SegmentInput[];
    }
  | { kind: "tracks"; source: string }
  | { kind: "inspect" }
  | { kind: "rename"; name: string };
export type XmlResult = {
  name: string;
  placemarks: number;
  coordinateNodes: number;
  xml?: string;
  tracks?: TrackData;
  content?: Content;
  edit?: EditResult;
  segment_edit?: SegmentEditResult;
};
export interface XmlPort {
  run(
    bytes: Uint8Array,
    operation: XmlOperation,
    signal?: AbortSignal,
  ): Promise<XmlResult>;
}
/** M6 store must implement atomic revision comparison plus event append in one transaction. */
export interface TaskStore {
  create(task: Task): Promise<void>;
  get(id: string): Promise<Task | undefined>;
  update(
    task: Task,
    expectedRevision: number,
    events: readonly TaskEvent[],
  ): Promise<void>;
  interruptUnfinished(): Promise<number>;
}
