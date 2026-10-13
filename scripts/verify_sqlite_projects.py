"""Real browser SQLite project save/reopen, old JSON relink and content fingerprint rejection.

Uses an existing isolated QA server/archive; writes artifacts only under --output.
"""

import argparse
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

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
    accept_dialogs = {"value": True}
    page.on("dialog", lambda d: d.accept() if accept_dialogs["value"] else d.dismiss())
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
    page.locator("#open-export").click()
    page.locator("#title").fill("数据库项目 · 分段原样")
    page.evaluate("window.tracktool.renderer.ready()")
    saved = page.evaluate("window.tracktool.state")
    page.locator("#save-db-project").click()
    page.locator("#project-name-input").fill("SQLite 验收项目")
    page.locator("#confirm-save").click()
    page.locator("#status").filter(has_text="项目已保存").wait_for()
    assert page.locator("#project-name").inner_text() == "SQLite 验收项目"
    assert page.locator("#dirty").inner_text() == "已保存"
    page.locator("#title").fill("更新后的图片标题")
    page.locator("#save-db-project").click()
    page.locator("#status").filter(has_text="项目已保存").wait_for()
    assert page.locator("#save-dialog").is_hidden()
    assert page.locator("#project-name").inner_text() == "SQLite 验收项目"
    saved = page.evaluate("window.tracktool.state")
    page.locator("#project-menu > summary").click()
    page.locator("#save-as-project").click()
    page.locator("#project-name-input").fill("项目副本")
    page.locator("#confirm-save").click()
    page.locator("#status").filter(has_text="项目已保存").wait_for()
    expect(page.locator("#project-name")).to_have_text("项目副本")
    page.reload()
    page.locator("#status").filter(has_text="地图已就绪").wait_for(timeout=90000)
    page.locator("#browse").click()
    page.locator("#folder-path").fill(str(args.archive.parent))
    page.locator("#go-folder").click()
    page.get_by_role("button", name="◇ " + args.archive.name, exact=True).click()
    page.locator("#status").filter(has_text="已打开归档").wait_for()
    page.locator("#project-menu > summary").click()
    page.locator("#load-db-project").click()
    page.locator("#project-search").fill("SQLite 验收")
    page.locator("#project-list").get_by_role("button", name="SQLite 验收项目", exact=True).click()
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
    page.locator("#open-export").click()
    with page.expect_download(timeout=180000) as download:
        with page.expect_response("**/api/export") as submitted:
            page.locator("#export").click()
        assert submitted.value.ok, submitted.value.text()
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
    page.locator("#project-menu > summary").click()
    page.locator("#load-db-project").click()
    page.locator("#project-search").fill("SQLite 验收")
    page.locator("#project-list").get_by_role("button", name="SQLite 验收项目", exact=True).click()
    page.locator("#status").filter(has_text="项目已恢复").wait_for(timeout=90000)
    assert page.evaluate("window.tracktool.state") == saved
    page.locator("#open-export").click()
    page.locator("#title").fill("不能丢掉的编辑")
    edited = page.evaluate("window.tracktool.state")
    accept_dialogs["value"] = False
    page.locator("#project-menu > summary").click()
    page.locator("#new-project").click()
    assert page.evaluate("window.tracktool.state") == edited
    accept_dialogs["value"] = True
    page.locator("#project-menu > summary").click()
    page.locator("#new-project").click()
    page.locator("#status").filter(has_text="新项目已就绪").wait_for(timeout=90000)
    fresh = page.evaluate("window.tracktool.state")
    assert fresh["archive"] == saved["archive"] and not fresh["tracks"] and not fresh["title"]
    expect(page.locator("#project-name")).to_have_text("未命名项目")
    page.locator("#save-db-project").click()
    assert page.locator("#save-dialog").is_visible()
    page.locator('[data-dismiss="save-dialog"]').last.click()
    assert not errors, errors
    (args.output / "report.json").write_text(
        json.dumps(
            {
                "saved": saved,
                "page_errors": errors,
                "verified": [
                    "SQLite save",
                    "save current project without renaming",
                    "project name independent of title",
                    "save as",
                    "searchable project list",
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
