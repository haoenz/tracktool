import { AppError, checkCancelled, errorInfo } from "../domain/errors.js";
import { entryName, filenameDate } from "../domain/archive.js";
import type {
  ArchiveInput,
  ArchiveRequest,
  ArchiveResult,
  Category,
  Content,
} from "../domain/archive.js";
import { tagMap } from "../domain/config.js";
import { kmlRoot, xmlText } from "../domain/kml-edit.js";
import type { EditOperation } from "../domain/kml-edit.js";
import type { BatchResult } from "../shared/contracts.js";
import type { Context } from "./context.js";
import type { XmlPort } from "./ports.js";
export type Source = {
  bytes: Uint8Array;
  sha256: string;
  path: string;
  name: string;
  stem: string;
  directory: string;
};
export interface KmlFiles {
  read(file: string): Promise<Source>;
  write(
    file: string,
    xml: string,
    options?: { exclusive?: boolean; expected?: string },
  ): Promise<void>;
  join(directory: string, name: string): string;
  checkOutput(output: string, reserved: string[]): void;
}
export interface ArchivePort {
  execute(
    request: ArchiveRequest,
    signal?: AbortSignal,
  ): Promise<ArchiveResult>;
}
export interface ElevationPort {
  get(
    locations: [number, number][],
    key: string,
    signal: AbortSignal,
  ): Promise<(number | null)[]>;
}
export class KmlService {
  constructor(
    private readonly files: KmlFiles,
    private readonly xml: XmlPort,
    private readonly archive: ArchivePort,
    private readonly elevation: ElevationPort,
  ) {}
  private log(
    ctx: Context,
    message: string,
    level: "INFO" | "WARNING" = "INFO",
  ) {
    ctx.report({ type: "log", level, message });
  }
  async archiveOperation(
    ctx: Context,
    request: ArchiveRequest,
  ): Promise<ArchiveResult> {
    checkCancelled(ctx.signal);
    if (ctx.mode === "plan" && request.kind !== "status") {
      if (request.kind === "pop")
        await this.archive.execute({ ...request, preview: true }, ctx.signal);
      this.log(ctx, `Would ${request.kind}: ${JSON.stringify(request)}`);
      return { message: `Would ${request.kind}` };
    }
    const result = await this.archive.execute(request, ctx.signal);
    this.log(ctx, result.message);
    for (const warning of result.warnings ?? [])
      this.log(ctx, warning, "WARNING");
    return result;
  }
  async content(
    ctx: Context,
    file: string,
  ): Promise<{ source: Source; content: Content; category: Category | null }> {
    const source = await this.files.read(file);
    const content = (
      await this.xml.run(source.bytes, { kind: "content" }, ctx.signal)
    ).content!;
    return {
      source,
      content,
      category:
        (tagMap(ctx.config).get(content.tag) as Category | undefined) ?? null,
    };
  }
  async batch(
    ctx: Context,
    files: string[],
    run: (file: string) => Promise<void>,
  ): Promise<BatchResult> {
    const items: BatchResult["items"] = [];
    const unique = [...new Set(files)];
    for (const [i, file] of unique.entries()) {
      checkCancelled(ctx.signal);
      try {
        await run(file);
        items.push({ status: "succeeded", path: file });
      } catch (error) {
        if (error instanceof AppError && error.code === "CANCELLED")
          throw error;
        const info = errorInfo(error);
        items.push({ status: "failed", path: file, error: info });
        this.log(ctx, `${file}: ${info.message}`, "WARNING");
      }
      ctx.report({ type: "progress", completed: i + 1, total: unique.length });
    }
    return {
      items,
      exitCode: items.some((i) => i.status === "failed") ? 3 : 0,
    };
  }
  async push(
    ctx: Context,
    files: string[],
    database: string,
    backup: string,
    move: boolean,
    override?: Category,
  ): Promise<BatchResult> {
    const entries: ArchiveInput[] = [];
    const result = await this.batch(ctx, files, async (file) => {
      const { source, category } = await this.content(ctx, file);
      const kind = override ?? category;
      if (!kind)
        throw new AppError(
          "USER_INPUT",
          "Unknown TrackTags; use kml set-tag or --type",
        );
      filenameDate(source.name);
      entries.push({
        source: source.path,
        category: kind,
        member: entryName(source.name, kind),
        sha256: source.sha256,
      });
    });
    if (entries.length)
      await this.archiveOperation(ctx, {
        kind: "push",
        database,
        entries,
        backup,
        move,
      });
    return result;
  }
  async edit(
    ctx: Context,
    file: string,
    operation: EditOperation,
    output?: string,
  ): Promise<string[]> {
    checkCancelled(ctx.signal);
    if (operation.kind === "set-tag" && !tagMap(ctx.config).has(operation.tag))
      throw new AppError(
        "USER_INPUT",
        `Unknown activity: ${operation.tag}; configure track_tag first`,
      );
    const source = await this.files.read(file);
    const result = (
      await this.xml.run(source.bytes, { kind: "edit", operation }, ctx.signal)
    ).edit!;
    const paths: string[] = [];
    for (const warning of result.warnings ?? [])
      this.log(ctx, warning, "WARNING");
    for (const item of result.outputs) {
      const target =
        output ??
        (item.name
          ? this.files.join(source.directory, item.name)
          : source.path);
      paths.push(target);
      if (ctx.mode === "plan") this.log(ctx, `Would write ${target}`);
      else {
        checkCancelled(ctx.signal);
        await this.files.write(target, item.xml, {
          expected: target === source.path ? source.sha256 : undefined,
        });
        this.log(ctx, `Wrote ${target}`);
      }
    }
    return paths;
  }
  async fillAltitude(ctx: Context, file: string, key: string): Promise<void> {
    const source = await this.files.read(file);
    const locations = (
      await this.xml.run(
        source.bytes,
        { kind: "edit", operation: { kind: "altitude-targets" } },
        ctx.signal,
      )
    ).edit!.locations!;
    if (!locations.length) {
      this.log(ctx, "No missing altitude tracks");
      return;
    }
    if (ctx.mode === "plan") {
      this.log(
        ctx,
        `Would query elevation for ${locations.length} points and write ${source.path}`,
      );
      return;
    }
    const values = await this.elevation.get(locations, key, ctx.signal);
    const result = (
      await this.xml.run(
        source.bytes,
        { kind: "edit", operation: { kind: "altitude-apply", values } },
        ctx.signal,
      )
    ).edit!;
    checkCancelled(ctx.signal);
    await this.files.write(source.path, result.outputs[0]!.xml, {
      expected: source.sha256,
    });
    this.log(ctx, `Filled altitude for ${locations.length} points`);
  }
  async merge(
    ctx: Context,
    files: string[],
    output: string,
    database: string,
    backup: string,
    keep: boolean,
    connected: boolean,
    reserved: string[],
  ): Promise<void> {
    this.files.checkOutput(output, reserved); // Before reading any source or archive.
    const inputs: ArchiveInput[] = [];
    const contents: Content[] = [];
    for (const file of [...new Set(files)]) {
      const { source, content, category } = await this.content(ctx, file);
      contents.push(content);
      inputs.push({
        source: source.path,
        member: entryName(source.name, category ?? "_unclassified"),
        category,
        sha256: source.sha256,
      });
    }
    const segments = contents.map((c) => c.segments.join(" "));
    const geometry = connected
      ? `<LineString><coordinates>${xmlText(segments.join(" "))}</coordinates></LineString>`
      : `<MultiGeometry>${segments.map((s) => `<LineString><coordinates>${xmlText(s)}</coordinates></LineString>`).join("")}</MultiGeometry>`;
    const name = output
      .replaceAll("\\", "/")
      .split("/")
      .at(-1)!
      .replace(/\.[^.]*$/, "");
    const xml = kmlRoot(
      `<Document><Folder><Placemark><name>${xmlText(name)}</name><description>${xmlText(contents[0]?.description ?? "")}</description>${geometry}</Placemark></Folder></Document>`,
    );
    if (ctx.mode === "plan") {
      this.log(ctx, `Would merge ${files.length} files into ${output}`);
      return;
    }
    checkCancelled(ctx.signal);
    await this.files.write(output, xml, { exclusive: true });
    await this.archiveOperation(ctx, {
      kind: "push",
      database,
      backup,
      entries: inputs,
      move: !keep,
    });
    this.log(ctx, `Merged ${files.length} files into ${output}`);
  }
}
