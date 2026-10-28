import { chromium, type Browser } from "playwright";
import { randomBytes } from "node:crypto";
import { AppError } from "../../domain/errors.js";
import type { OverviewStatus } from "../../shared/overview.js";
import type { PrintDocument } from "../../shared/print.js";
import { mapExportFileName } from "../../shared/print.js";
import type { MapExport } from "../../shared/print.js";

const retention = 15 * 60_000;
export interface VisibleTrack {
  id: string;
  entry: string;
}
export interface ExportJob {
  status: "queued" | "rendering" | "done" | "failed";
  created: number;
  finished?: number;
  phase: MapExport["phase"];
  fileName: string;
  document: PrintDocument;
  visible: VisibleTrack[];
  overview: OverviewStatus;
  png?: Buffer;
  error?: string;
  report?: Record<string, unknown>;
}
export class Exports {
  private jobs = new Map<string, ExportJob>();
  private running?: Promise<void>;
  private browser?: Browser;
  constructor(
    private readonly origin: () => string,
    private readonly token: string,
  ) {}
  private sweep() {
    for (const [id, job] of this.jobs)
      if (job.finished !== undefined && Date.now() - job.finished >= retention)
        this.jobs.delete(id);
  }
  summary(id: string): MapExport {
    const job = this.get(id);
    return {
      id,
      kind: "png",
      status: job.status,
      phase: job.phase,
      created: job.created,
      expiresAt: (job.finished ?? job.created) + retention,
      fileName: job.fileName,
      title: job.document.title,
      width: job.document.output.width,
      height: job.document.output.height,
      trackCount: job.visible.length,
      size: job.png?.length,
      error: job.error,
      report: job.report,
    };
  }
  list(archive: string): MapExport[] {
    this.sweep();
    return [...this.jobs]
      .filter(([, job]) => job.document.archive === archive)
      .map(([id]) => this.summary(id))
      .sort((a, b) => b.created - a.created);
  }
  submit(
    document: PrintDocument,
    visible: VisibleTrack[],
    overview: OverviewStatus,
  ): string {
    this.sweep();
    if (this.running)
      throw new AppError("USER_INPUT", "已有导出任务，请等待完成后重试");
    while (this.jobs.size >= 5)
      this.jobs.delete(this.jobs.keys().next().value!);
    const id = randomBytes(20).toString("hex"),
      job: ExportJob = {
        status: "queued",
        created: Date.now(),
        phase: "preparing",
        fileName: mapExportFileName(document.title || "tracktool-map", "png"),
        document: structuredClone(document),
        visible,
        overview,
      };
    this.jobs.set(id, job);
    this.running = this.render(id, job).finally(() => {
      this.running = undefined;
    });
    return id;
  }
  get(id: string): ExportJob {
    this.sweep();
    const job = this.jobs.get(id);
    if (!job)
      throw new AppError(
        "USER_INPUT",
        "导出结果已过期或服务已重启，请重新导出",
      );
    return job;
  }
  private async render(id: string, job: ExportJob) {
    const failures: string[] = [];
    job.status = "rendering";
    try {
      this.browser = await chromium.launch({
        headless: true,
        args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
      });
      const { frame, output } = job.document;
      const page = await this.browser.newPage({
        viewport: { width: frame.width, height: frame.height },
        deviceScaleFactor: output.width / frame.width,
        extraHTTPHeaders: {
          "X-Tracktool-Token": this.token,
          "X-Tracktool-Render": this.token,
        },
      });
      page.on("pageerror", (error) => failures.push(error.message));
      page.on("requestfailed", (request) => {
        if (
          request.failure()?.errorText === "net::ERR_ABORTED" &&
          new URL(request.url()).pathname.startsWith("/tiles/")
        )
          return;
        failures.push("资源请求失败");
      });
      page.on("response", (r) => {
        if (r.status() >= 400) failures.push(`资源 HTTP ${r.status()}`);
      });
      job.phase = "resources";
      await page.goto(`${this.origin()}/render?job=${id}`, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });
      await page
        .locator("body[data-render-status]")
        .waitFor({ state: "attached", timeout: 90_000 });
      const report = (await page.evaluate("window.renderStatus")) as {
        error?: string;
        ready?: boolean;
        camera?: unknown;
      };
      if (report.error || failures.length || !report.ready)
        throw new AppError(
          "USER_INPUT",
          `导出中止：${report.error ?? failures.slice(0, 5).join("；")}`,
        );
      job.phase = "rendering";
      const png = await page.screenshot({
        type: "png",
        animations: "disabled",
        timeout: 30_000,
      });
      if (failures.length)
        throw new AppError(
          "USER_INPUT",
          `导出资源失败：${failures.join("；")}`,
        );
      if (
        png.readUInt32BE(16) !== output.width ||
        png.readUInt32BE(20) !== output.height
      )
        throw new AppError(
          "USER_INPUT",
          "浏览器输出尺寸不符合项目尺寸，请改用 960 的整数倍长边后重试",
        );
      job.png = png;
      job.report = {
        chromium: this.browser.version(),
        width: output.width,
        height: output.height,
        camera: report.camera,
      };
    } catch (error) {
      job.error =
        error instanceof AppError
          ? error.message
          : error instanceof Error &&
              error.message.includes("Executable doesn't exist")
            ? "PNG 导出组件尚未安装，请在服务端运行 tracktool setup chromium 后重试。"
            : "图片生成失败，请重试；仍失败时请检查服务端出图组件与地图资源。";
    } finally {
      try {
        await this.browser?.close();
      } catch {
        job.error ??= "导出浏览器清理失败，请重试";
      }
      this.browser = undefined;
      job.status = job.error ? "failed" : "done";
      job.phase = job.error ? "failed" : "done";
      job.finished = Date.now();
    }
  }
  async close() {
    await this.browser?.close();
    await this.running;
    this.jobs.clear();
  }
}
