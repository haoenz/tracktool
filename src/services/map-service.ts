import type { Project } from "../shared/project.js";
import { ProjectSchema, upgradeProject } from "../shared/project.js";
import { SelectionRequest, ProjectSaveRequest } from "../shared/map.js";
import type { Catalog, Selection } from "../shared/map.js";
import { AppError } from "../domain/errors.js";
import type { ProjectTrack } from "../shared/project-track.js";
export interface MapStore {
  catalog(path: string): Promise<Catalog>;
  selection(
    path: string,
    entries: string[],
    expected?: Record<string, string>,
    signal?: AbortSignal,
    references?: ProjectTrack[],
  ): Promise<Selection>;
  projects(path: string): Promise<string[]>;
  save(path: string, name: string, state: Project): Promise<void>;
  load(path: string, name: string): Promise<unknown>;
}
export class MapService {
  constructor(private readonly store: MapStore) {}
  catalog(path: string) {
    if (!path) throw new AppError("USER_INPUT", "请先选择 SQLite 归档");
    return this.store.catalog(path);
  }
  selection(path: string, entries: string[], signal?: AbortSignal) {
    const request = SelectionRequest.safeParse({ archive: path, entries });
    if (!request.success)
      throw new AppError("USER_INPUT", "每次最多选择 200 条不同的完整归档路径");
    return this.store.selection(path, entries, undefined, signal);
  }
  async project(value: unknown): Promise<{ state: Project } & Selection> {
    const parsed = ProjectSchema.safeParse(upgradeProject(value));
    if (!parsed.success)
      throw new AppError(
        "USER_INPUT",
        `地图项目无效：${parsed.error.issues.map((i) => i.message).join("；")}`,
      );
    const state = parsed.data;
    if (!state.archive) {
      if (state.tracks.length)
        throw new AppError("USER_INPUT", "项目有轨迹但没有归档引用");
      return { state, archive: "", tracks: [], errors: [] };
    }
    const selection = await this.store.selection(
      state.archive,
      state.tracks.map((t) => t.entry),
      Object.fromEntries(state.tracks.map((t) => [t.entry, t.sha256])),
      undefined,
      state.tracks,
    );
    if (
      !selection.errors.length &&
      selection.tracks.every((t) => t.reference)
    ) {
      state.schema = 3;
      state.tracks = selection.tracks.map((t) => t.reference!);
    }
    return { state, ...selection };
  }
  async save(name: string, value: unknown) {
    const { state, ...selected } = await this.project(value);
    if (selected.errors.length)
      throw new AppError("USER_INPUT", "源轨迹缺失或变化，不能保存项目");
    if (!ProjectSaveRequest.safeParse({ name, state }).success)
      throw new AppError("USER_INPUT", "项目名称需为 1–120 字");
    await this.store.save(selected.archive, name, state);
  }
  async load(path: string, name: string) {
    const raw = await this.store.load(path, name);
    if (!raw || typeof raw !== "object")
      throw new AppError("USER_INPUT", "地图项目无效");
    return this.project({
      ...raw,
      archive: (await this.store.catalog(path)).archive,
    });
  }
  projects(path: string) {
    return this.store.projects(path);
  }
}
