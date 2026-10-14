import { createContext, useContext } from "react";
import type { SelectedTrack } from "../shared/map.js";
export type Panel =
  | "library"
  | "style"
  | "export"
  | "project"
  | "archive"
  | "tracks"
  | "tasks"
  | "settings";
export interface Workspace {
  archive: string;
  selected: SelectedTrack[];
  open: (panel: Panel, task?: string) => void;
  inspect: (id: string) => Promise<void>;
  refresh: (archive: string) => Promise<void>;
}
export const WorkspaceContext = createContext<Workspace | null>(null);
export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("Missing map workspace");
  return context;
}
