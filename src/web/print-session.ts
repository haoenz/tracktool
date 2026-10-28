import {
  defaultMapState,
  MapStateSchema,
  type MapState,
} from "../shared/map-state.js";

type Composition = Pick<MapState, "frame" | "output" | "title">;

export function rememberedPrintDraft(archive: string): string | undefined {
  try {
    return sessionStorage.getItem(`tracktool-draft:${archive}`) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberPrintDraft(archive: string, id?: string) {
  try {
    if (id) sessionStorage.setItem(`tracktool-draft:${archive}`, id);
    else sessionStorage.removeItem(`tracktool-draft:${archive}`);
  } catch {
    /* Optional session persistence. */
  }
}

// A reload restores only the frame UI. Style and visibility still come from
// their authoritative stores; full documents are restored explicitly.
export function rememberedPrintFrame(archive: string): Composition | undefined {
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(`tracktool-frame:${archive}`) ?? "null",
    );
    if (!saved) return;
    const parsed = MapStateSchema.safeParse({
      ...defaultMapState(),
      frame: saved.frame,
      output: saved.output,
      title: saved.title,
    });
    if (parsed.success)
      return {
        frame: parsed.data.frame,
        output: parsed.data.output,
        title: parsed.data.title,
      };
  } catch {
    /* Optional session persistence. */
  }
}

export function rememberPrintFrame(
  archive: string,
  { frame, output, title }: MapState,
) {
  try {
    sessionStorage.setItem(
      `tracktool-frame:${archive}`,
      JSON.stringify({ frame, output, title }),
    );
  } catch {
    /* Optional session persistence. */
  }
}
