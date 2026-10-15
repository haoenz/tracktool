import path from "node:path";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { CATEGORIES, filenameDate } from "../../domain/archive.js";
import type { ArchiveResult, Category, Content } from "../../domain/archive.js";
import { kmlRoot, xmlText } from "../../domain/kml-edit.js";
import { AppError } from "../../domain/errors.js";
import type { XmlPort } from "../../services/ports.js";
import {
  activeEntries,
  rawObject,
  snapshot,
  transaction,
  schemaVersion,
} from "./database.js";
import { exportDisplay } from "./display-export.js";
import { withDocument } from "../xml/document.js";
import { syncDirectory, syncFile, temporary } from "../durable-files.js";
const styles: Record<Category, [string, string]> = {
  Default: ["普通行程", "ff2257ff"],
  Train: ["火车行程", "ff413830"],
  Flight: ["飞机行程", "1ab5ad00"],
};
function line(text: string, id?: string): string {
  return `<LineString${id ? ` id="${xmlText(id)}"` : ""}><coordinates>${xmlText(text)}</coordinates></LineString>`;
}
export async function rebuild(
  file: string,
  output: string,
  xml: XmlPort,
): Promise<ArchiveResult> {
  const warnings: string[] = [];
  const staged: { stage: string; target: string }[] = [];
  try {
    const { revision, files, versioned } = await snapshot(file, async (db) => {
      const revision = (
        db.prepare("SELECT revision FROM archive_meta").get() as {
          revision: number;
        }
      ).revision;
      const rows = db
        .prepare(
          `SELECT path,sha256,category FROM ${activeEntries(db)} ORDER BY path`,
        )
        .all() as { path: string; sha256: string; category: Category | null }[];
      const items = new Map<
        Category,
        { name: string; date: string; content?: Content; display?: string }[]
      >(CATEGORIES.map((c) => [c, []]));
      for (const row of rows) {
        if (!row.category) {
          warnings.push(`Unclassified entry omitted: ${row.path}`);
          continue;
        }
        try {
          const date = filenameDate(path.basename(row.path));
          if (schemaVersion(db) >= 3) {
            const raw = exportDisplay(db, row.path);
            const display = withDocument(raw, (doc) =>
              doc.root
                .find("./*")
                .map((n) => n.canonicalizeToString({ withComments: true }))
                .join(""),
            );
            items.get(row.category)!.push({
              name: path.basename(row.path, path.extname(row.path)),
              date,
              display,
            });
            continue;
          }
          const content = (
            await xml.run(rawObject(db, row.sha256), { kind: "content" })
          ).content!;
          if (!content.segments.length)
            throw new AppError("USER_INPUT", "No track geometry");
          items.get(row.category)!.push({
            name: path.basename(row.path, path.extname(row.path)),
            date,
            content,
          });
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== "USER_INPUT")
            throw error;
          warnings.push(`${row.path}: ${error.message}`);
        }
      }
      const files: { name: string; xml: string }[] = [];
      for (const category of CATEGORIES) {
        const months = new Map<string, string[]>(),
          seen = new Set<string>(),
          mobile: string[] = [];
        const mobileSeen = new Set<string>();
        for (const item of items.get(category)!) {
          const month = item.date.slice(0, 7).replace("-", ""),
            key = `${month}/${item.name}`;
          if (item.display !== undefined) {
            if (!months.has(month)) months.set(month, []);
            const fragment = `<Folder><name>${xmlText(item.name)}</name>${item.display}</Folder>`;
            months.get(month)!.push(fragment);
            mobile.push(fragment);
            continue;
          }
          const content = item.content!;
          const lines = content.segments.map((s) => line(s)).join("");
          if (!seen.has(key)) {
            seen.add(key);
            if (!months.has(month)) months.set(month, []);
            months
              .get(month)!
              .push(
                `<Placemark><name>${xmlText(item.name)}</name><description>${xmlText(content.description)}</description><styleUrl>#${category}</styleUrl>${content.segments.length > 1 ? `<MultiGeometry>${lines}</MultiGeometry>` : lines}</Placemark>`,
              );
          }
          if (!mobileSeen.has(item.name)) {
            mobileSeen.add(item.name);
            mobile.push(
              content.segments.length > 1
                ? `<MultiGeometry id="${xmlText(item.name)}">${lines}</MultiGeometry>`
                : line(content.segments[0]!, item.name),
            );
          }
        }
        const years = new Map<string, string[]>();
        for (const [month, marks] of months) {
          const year = month.slice(0, 4);
          if (!years.has(year)) years.set(year, []);
          years
            .get(year)!
            .push(
              `<Document><name>${month}</name>${marks.join("")}</Document>`,
            );
        }
        const [name, color] = styles[category];
        const folders = [...years]
          .map(
            ([year, months]) =>
              `<Folder><name>${year}</name>${months.join("")}</Folder>`,
          )
          .join("");
        files.push(
          {
            name: `${category}.kml`,
            xml: kmlRoot(
              `<Folder><name>${name}</name><Style id="${category}"><LineStyle><color>${color}</color><width>3</width></LineStyle></Style>${folders}</Folder>`,
            ),
          },
          {
            name: `${category}.Mobile.kml`,
            xml: kmlRoot(
              schemaVersion(db) >= 3
                ? `<Document>${mobile.join("")}</Document>`
                : `<Folder><Placemark><MultiGeometry>${mobile.join("")}</MultiGeometry></Placemark></Folder>`,
            ),
          },
        );
      }
      return { revision, files, versioned: schemaVersion(db) >= 3 };
    });
    mkdirSync(output, { recursive: true });
    for (const f of files) {
      // Versioned fragments were parsed and canonicalized individually above.
      // Only escaped wrapper text is added. A whole collection can exceed the
      // single-source XML limit; do not parse the entire library a second time.
      if (!versioned) await xml.run(Buffer.from(f.xml), { kind: "inspect" });
      const target = path.join(output, f.name),
        stage = temporary(target);
      staged.push({ stage, target });
      writeFileSync(stage, f.xml, { flag: "wx" });
      syncFile(stage);
    }
    transaction(file, true, (db) => {
      // Rebuild is an explicit refresh: reject a stale snapshot before replacing any view.
      const current = (
        db.prepare("SELECT revision FROM archive_meta").get() as {
          revision: number;
        }
      ).revision;
      if (current !== revision)
        throw new AppError(
          "USER_INPUT",
          "Archive changed during rebuild; run rebuild again",
        );
      for (const f of staged) renameSync(f.stage, f.target);
      syncDirectory(output);
      if (output === path.dirname(file))
        db.prepare("UPDATE archive_meta SET views_revision=?").run(revision);
    });
    return {
      message: "Collections rebuilt",
      paths: staged.map((f) => f.target),
      warnings,
    };
  } finally {
    for (const f of staged) rmSync(f.stage, { force: true });
  }
}
