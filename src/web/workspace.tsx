import {
  createContext,
  useContext,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { SelectedTrack } from "../shared/map.js";
export type Panel =
  | "library"
  | "style"
  | "export"
  | "project"
  | "archive"
  | "settings";
export interface EditMap {
  tracks: SelectedTrack[];
  pick?: (p: [number, number]) => void;
  segment?: string;
}
export interface Workspace {
  editMap?: Dispatch<SetStateAction<EditMap | undefined>>;
  fit?: (tracks: SelectedTrack[]) => void;
  archive: string;
  selected: SelectedTrack[];
  draft?: (key: string, dirty: boolean) => void;
  open: (panel: Panel, task?: string) => void;
  showTrack?: (id: string) => void;
  inspect: (id: string) => Promise<void>;
  refresh: (archive: string) => Promise<void>;
}
export const WorkspaceContext = createContext<Workspace | null>(null);
export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("Missing map workspace");
  return context;
}
