"""Real browser SQLite project save/reopen, old JSON relink and content fingerprint rejection.

Uses an existing isolated QA server/archive; writes artifacts only under --output.
"""

import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--url", required=True)
parser.add_argument("--archive", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = browser.new_page(viewport={"width": 1500, "height": 1000}, accept_downloads=True)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", lambda d: d.accept("SQLite 验收项目") if d.type == "prompt" else d.accept())
    page.goto(args.url)
    page.locator("#status").filter(has_text="地图已就绪").wait_for(timeout=90000)
    page.locator("#browse").click()
    page.locator("#folder-path").fill(str(args.archive.parent))
    page.locator("#go-folder").click()
    page.get_by_role("button", name="◇ " + args.archive.name, exact=True).click()
    page.locator("#status").filter(has_text="已打开归档").wait_for()
    page.locator("#track-list input").first.check()
    page.locator("#status").filter(has_text="已绘制").wait_for(timeout=90000)
    page.locator("#fit").click()
    page.locator("#title").fill("数据库项目 · 分段原样")
    page.evaluate("window.tracktool.renderer.ready()")
    saved = page.evaluate("window.tracktool.state")
    page.locator("#save-db-project").click()
    page.locator("#status").filter(has_text="项目已保存").wait_for()
    page.reload()
    page.locator("#status").filter(has_text="地图已就绪").wait_for(timeout=90000)
    page.locator("#browse").click()
    page.locator("#folder-path").fill(str(args.archive.parent))
    page.locator("#go-folder").click()
    page.get_by_role("button", name="◇ " + args.archive.name, exact=True).click()
    page.locator("#status").filter(has_text="已打开归档").wait_for()
    page.locator("#load-db-project").click()
    page.locator("#status").filter(has_text="项目已恢复").wait_for(timeout=90000)
    assert page.evaluate("window.tracktool.state") == saved
    # Old schema-1 JSON from another machine: explicit current-archive relink.
    legacy = dict(saved, archive="/old-machine/Archive.zip")
    legacy_file = args.output / "legacy-project.json"
    legacy_file.write_text(json.dumps(legacy, ensure_ascii=False))
    page.locator("#project-file").set_input_files(legacy_file)
    page.locator("#status").filter(has_text="项目已恢复").wait_for(timeout=90000)
    assert page.evaluate("window.tracktool.state") == saved
    # Existing version validation survives both save and export paths.
    bad = dict(saved, versions={"renderer": "obsolete"})
    changed = args.output / "old-versions.json"
    changed.write_text(json.dumps(bad))
    page.locator("#project-file").set_input_files(changed)
    page.locator("#status").filter(has_text="资源版本").wait_for(timeout=90000)
    page.locator("#adopt-versions").click()
    page.evaluate("window.tracktool.renderer.ready()")
    with page.expect_download(timeout=180000) as download:
        page.locator("#export").click()
    download.value.save_as(args.output / "sqlite-project.png")
    page.screenshot(path=str(args.output / "sqlite-project-editor.png"))
    bad = json.loads(json.dumps(saved))
    bad["tracks"][0]["sha256"] = "0" * 64
    mismatched = args.output / "changed-content.json"
    mismatched.write_text(json.dumps(bad))
    page.locator("#project-file").set_input_files(mismatched)
    page.locator("#status").filter(has_text="内容变化").wait_for(timeout=90000)
    assert page.locator("#export").is_disabled()
    assert page.locator("#load-db-project").is_enabled()
    page.locator("#load-db-project").click()
    page.locator("#status").filter(has_text="项目已恢复").wait_for(timeout=90000)
    assert page.evaluate("window.tracktool.state") == saved
    assert not errors, errors
    (args.output / "report.json").write_text(
        json.dumps(
            {
                "saved": saved,
                "page_errors": errors,
                "verified": [
                    "SQLite save",
                    "reload",
                    "SQLite reopen",
                    "old JSON relink with SHA",
                    "resource versions",
                    "PNG export",
                    "changed SHA blocks export",
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    print("PASS: SQLite project save/reopen, old JSON relink, version checks, PNG and content mismatch", flush=True)
    browser.close()
