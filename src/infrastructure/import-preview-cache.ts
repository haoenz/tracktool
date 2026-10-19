import { createHash } from "node:crypto";
import { AppError, checkCancelled } from "../domain/errors.js";
import type { Source } from "../services/kml-service.js";
import type { XmlPort } from "../services/ports.js";

type Entry = {
  expires: number;
  tag?: string;
  error?: AppError;
  edits: Map<string, string>;
};

/** Cache only validation metadata and digests, never XML bytes or track arrays. */
export class ImportPreviewCache {
  private entries = new Map<string, Entry>();
  constructor(
    private readonly capacity = 1000,
    private readonly ttl = 15 * 60_000,
    private readonly now = Date.now,
  ) {}

  async inspect(
    source: Source,
    xml: XmlPort,
    tag?: string,
    signal?: AbortSignal,
  ) {
    checkCancelled(signal);
    const now = this.now();
    for (const [key, value] of this.entries)
      if (value.expires <= now) this.entries.delete(key);
    // The digest is freshly computed by the file reader, not inferred from mtime.
    const key = JSON.stringify([source.path, source.sha256]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { expires: now + this.ttl, edits: new Map() };
      try {
        entry.tag = (
          await xml.run(source.bytes, { kind: "content" }, signal)
        ).content!.tag;
        const parsed = await xml.run(
          source.bytes,
          { kind: "tracks", source: source.path },
          signal,
        );
        if (
          !parsed.tracks?.tracks.some((track) =>
            track.segments.some((segment) => segment.longitude.length > 0),
          )
        )
          throw new AppError("USER_INPUT", "KML 中没有有效轨迹点");
        checkCancelled(signal);
      } catch (error) {
        // Cancellation, worker failures and I/O failures must remain retryable.
        checkCancelled(signal);
        if (!(error instanceof AppError) || error.code !== "USER_INPUT")
          throw error;
        entry.error = error;
      }
      this.entries.set(key, entry);
      while (this.entries.size > this.capacity)
        this.entries.delete(this.entries.keys().next().value!);
    } else {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    if (entry.error) throw entry.error;
    let sha256 = source.sha256;
    if (tag !== undefined && tag !== entry.tag) {
      const cached = entry.edits.get(tag);
      if (cached) sha256 = cached;
      else {
        const edited = await xml.run(
          source.bytes,
          { kind: "edit", operation: { kind: "set-tag", tag, create: true } },
          signal,
        );
        checkCancelled(signal);
        sha256 = createHash("sha256")
          .update(edited.edit!.outputs[0]!.xml)
          .digest("hex");
        entry.edits.set(tag, sha256);
        if (entry.edits.size > 16)
          entry.edits.delete(entry.edits.keys().next().value!);
      }
    }
    return { tag: entry.tag ?? "", sha256 };
  }
}
