import { AppError } from "./errors.js";
export type Category = "Default" | "Train" | "Flight";
export const CATEGORIES: Category[] = ["Default", "Train", "Flight"];
export function memberName(name: string): string {
  if (
    !name ||
    [...name].some((c) => c.charCodeAt(0) < 32) ||
    /[\\:]/.test(name) ||
    name.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new AppError("USER_INPUT", `Unsafe archive path: ${name}`);
  return name;
}
export function filenameDate(name: string): string {
  const date = /\d{4}-\d{2}-\d{2}/.exec(name)?.[0];
  if (!date)
    throw new AppError(
      "USER_INPUT",
      `Filename must contain YYYY-MM-DD: ${name}`,
    );
  return date;
}
export function entryName(name: string, category: string): string {
  const date = /\d{4}-\d{2}-\d{2}/.exec(name)?.[0];
  return memberName(`${category}/${date ? date.slice(0, 7) + "/" : ""}${name}`);
}
export type Content = { tag: string; description: string; segments: string[] };
export type ArchiveInput = {
  source: string;
  category: Category | null;
  member: string;
  sha256: string;
};
export type ArchiveRequest =
  | { kind: "init"; directory: string; zip?: string }
  | { kind: "status" | "recover" | "migrate"; database: string }
  | {
      kind: "push";
      database: string;
      entries: ArchiveInput[];
      backup: string;
      move: boolean;
    }
  | {
      kind: "pop";
      database: string;
      name: string;
      category?: Category;
      output: string;
      preview?: boolean;
    }
  | { kind: "backup"; database: string; output: string }
  | { kind: "rebuild"; database: string; output: string };
export type ArchiveStatus = {
  revision: number;
  entries: number;
  pending: number;
  zip_revision: number | null;
  zip_target: string | null;
  views_revision: number | null;
  zip_fresh: boolean;
};
export type ArchiveResult = {
  message: string;
  warnings?: string[];
  status?: ArchiveStatus;
  paths?: string[];
  count?: number;
};
