import { SelectionRequest } from "../shared/map.js";
import type { Catalog, Selection } from "../shared/map.js";
import { AppError } from "../domain/errors.js";
export interface MapStore {
  catalog(path: string): Promise<Catalog>;
  selection(
    path: string,
    entries: string[],
    signal?: AbortSignal,
  ): Promise<Selection>;
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
    return this.store.selection(path, entries, signal);
  }
}
