import type { Catalog } from "../shared/map.js";
import { AppError } from "../domain/errors.js";
export interface MapStore {
  catalog(path: string): Promise<Catalog>;
}
export class MapService {
  constructor(private readonly store: MapStore) {}
  catalog(path: string) {
    if (!path) throw new AppError("USER_INPUT", "请先配置 SQLite 归档");
    return this.store.catalog(path);
  }
}
