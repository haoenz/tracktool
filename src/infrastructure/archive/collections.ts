import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ArchiveResult, Category } from "../../domain/archive.js";
import { CATEGORIES, filenameDate } from "../../domain/archive.js";
import { AppError } from "../../domain/errors.js";
import { kmlRoot, xmlText } from "../../domain/kml-edit.js";
import { syncDirectory, syncFile, temporary } from "../durable-files.js";
import { withDocument } from "../xml/document.js";
import { snapshot, transaction } from "./database.js";
import { exportDisplay } from "./display-export.js";
const styles: Record<Category, [string, string]> = {
  Default: ["普通行程", "ff2257ff"],
  Train: ["火车行程", "ff413830"],
  Flight: ["飞机行程", "1ab5ad00"],
};
export async function rebuild(
  file: string,
  output: string,
  selected?: string[],
): Promise<ArchiveResult> {
  const warnings: string[] = [];
  const staged: { stage: string; target: string }[] = [];
  try {
    const { revision, files } = await snapshot(file, async (db) => {
      const revision = (
        db.prepare("SELECT revision FROM archive_meta").get() as {
          revision: number;
        }
      ).revision;
      let rows = db
        .prepare(
          `SELECT path,sha256,category FROM active_archive_entries ORDER BY path`,
        )
        .all() as { path: string; sha256: string; category: Category | null }[];
      if (selected) {
        const requested = new Set(selected);
        rows = rows.filter((row) => requested.has(row.path));
        if (!requested.size || rows.length !== requested.size)
          throw new AppError(
            "USER_INPUT",
            "部分所选轨迹已不存在，请返回列表重新选择",
          );
      }
      const items = new Map<
        Category,
        { name: string; date: string; display: string }[]
      >(CATEGORIES.map((c) => [c, []]));
      for (const row of rows) {
        if (!row.category) {
          warnings.push(`Unclassified entry omitted: ${row.path}`);
          continue;
        }
        try {
          const date = filenameDate(path.basename(row.path));
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
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== "USER_INPUT")
            throw error;
          warnings.push(`${row.path}: ${error.message}`);
        }
      }
      const files: { name: string; xml: string }[] = [];
      for (const category of CATEGORIES) {
        const months = new Map<string, string[]>(),
          mobile: string[] = [];
        for (const item of items.get(category)!) {
          const month = item.date.slice(0, 7).replace("-", "");
          if (!months.has(month)) months.set(month, []);
          const fragment = `<Folder><name>${xmlText(item.name)}</name>${item.display}</Folder>`;
          months.get(month)!.push(fragment);
          mobile.push(fragment);
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
            xml: kmlRoot(`<Document>${mobile.join("")}</Document>`),
          },
        );
      }
      return { revision, files };
    });
    mkdirSync(output, { recursive: true });
    for (const f of files) {
      // Versioned fragments were parsed and canonicalized individually above.
      // Only escaped wrapper text is added. A whole collection can exceed the
      // single-source XML limit; do not parse the entire library a second time.
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
      if (!selected && output === path.dirname(file))
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
