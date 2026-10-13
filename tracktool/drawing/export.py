"""Render only the shared map canvas in a fresh Chromium at output resolution."""

import struct

from ..errors import UserInputError


def render_png(url: str, token: str, state: dict) -> tuple[bytes, dict]:
    from playwright.sync_api import sync_playwright

    frame, output = state["frame"], state["output"]
    failures = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
        )
        try:
            context = browser.new_context(
                viewport={"width": frame["width"], "height": frame["height"]},
                device_scale_factor=output["width"] / frame["width"],
                extra_http_headers={"X-Tracktool-Token": token},
            )
            page = context.new_page()
            page.on("pageerror", lambda error: failures.append(str(error)))
            page.on("requestfailed", lambda request: failures.append(f"资源请求失败：{request.url.split('?')[0]}"))
            page.on(
                "response",
                lambda response: failures.append(f"资源 HTTP {response.status}") if response.status >= 400 else None,
            )
            page.goto(url, wait_until="domcontentloaded", timeout=90000)
            page.locator("body[data-render-status]").wait_for(state="attached", timeout=90000)
            status = page.evaluate("window.renderStatus")
            if status.get("error") or failures:
                raise UserInputError("导出中止：" + (status.get("error") or "; ".join(failures[:5])))
            png = page.screenshot(type="png", animations="disabled", timeout=30000)
            if failures:
                raise UserInputError("导出资源失败：" + "; ".join(failures[:5]))
            width, height = struct.unpack(">II", png[16:24])
            if (width, height) != (output["width"], output["height"]):
                raise UserInputError(f"浏览器输出尺寸 {width}×{height} 不符合项目尺寸，请改用 960 的整数倍长边后重试")
            return png, {
                "chromium": browser.version,
                "width": width,
                "height": height,
                "labels": status.get("labels", []),
                "camera": status.get("camera"),
            }
        finally:
            browser.close()
