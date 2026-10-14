import { chromium, type Browser } from "playwright";
import { randomBytes } from "node:crypto";
import { AppError } from "../../domain/errors.js";
import type { Project } from "../../shared/project.js";
import type { SelectedTrack } from "../../shared/map.js";
export interface ExportJob {
  status: "queued" | "rendering" | "done" | "failed";
  created: number;
  state: Project;
  tracks?: SelectedTrack[];
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
  submit(state: Project, tracks: SelectedTrack[]): string {
    for (const [id, j] of this.jobs)
      if (
        !["queued", "rendering"].includes(j.status) &&
        Date.now() - j.created > 900_000
      )
        this.jobs.delete(id);
    if (this.running)
      throw new AppError("USER_INPUT", "已有导出任务，请等待完成后重试");
    while (this.jobs.size >= 5)
      this.jobs.delete(this.jobs.keys().next().value!);
    const id = randomBytes(20).toString("hex"),
      job: ExportJob = {
        status: "queued",
        created: Date.now(),
        state: structuredClone(state),
        tracks,
      };
    this.jobs.set(id, job);
    this.running = this.render(id, job).finally(() => {
      this.running = undefined;
    });
    return id;
  }
  get(id: string): ExportJob {
    const job = this.jobs.get(id);
    if (!job) throw new AppError("USER_INPUT", "导出任务不存在或已过期");
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
      const { frame, output } = job.state;
      const page = await this.browser.newPage({
        viewport: { width: frame.width, height: frame.height },
        deviceScaleFactor: output.width / frame.width,
        extraHTTPHeaders: {
          "X-Tracktool-Token": this.token,
          "X-Tracktool-Render": this.token,
        },
      });
      page.on("pageerror", (error) => failures.push(error.message));
      page.on("requestfailed", () => failures.push("资源请求失败"));
      page.on("response", (r) => {
        if (r.status() >= 400) failures.push(`资源 HTTP ${r.status()}`);
      });
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
        labels?: unknown;
        camera?: unknown;
      };
      if (report.error || failures.length || !report.ready)
        throw new AppError(
          "USER_INPUT",
          `导出中止：${report.error ?? failures.slice(0, 5).join("；")}`,
        );
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
        labels: report.labels,
        camera: report.camera,
      };
      job.status = "done";
    } catch (error) {
      job.error = error instanceof Error ? error.message : "导出失败";
      job.status = "failed";
    } finally {
      delete job.tracks;
      await this.browser?.close();
      this.browser = undefined;
    }
  }
  async close() {
    await this.browser?.close();
    await this.running;
    this.jobs.clear();
  }
}
