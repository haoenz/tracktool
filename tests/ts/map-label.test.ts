import { describe, expect, it } from "vitest";
import { mapLabel } from "../../src/domain/map-label.js";

describe("single map labels", () => {
  it.each([
    ["东京都/東京都", "东京都"],
    ["伦敦;倫敦", "伦敦"],
    ["雅加达 / 雅加達", "雅加达"],
    ["紐西蘭/新西兰", "新西兰"],
  ])("prefers the explicit simplified name for %s", (zh, hans) => {
    expect(mapLabel({ "name:zh": zh, "name:zh-Hans": hans })).toBe(hans);
  });

  it("prefers a single traditional or local name to a list of translations", () => {
    expect(
      mapLabel({
        "name:zh": "塔吉克斯坦 / 塔吉克",
        "name:zh-Hant": "塔吉克斯坦",
      }),
    ).toBe("塔吉克斯坦");
    expect(
      mapLabel({
        "name:zh-Hans": "新不伦瑞克省;新布兰斯威省",
        name: "New Brunswick;Nouveau-Brunswick",
        "name:en": "New Brunswick",
      }),
    ).toBe("New Brunswick");
    expect(
      mapLabel({
        "name:zh": "斯威士兰 / 史瓦蒂尼 / 斯威士蘭",
        name: "Eswatini",
      }),
    ).toBe("Eswatini");
  });

  it.each([
    ["新不伦瑞克省;新布兰斯威省", "新不伦瑞克省"],
    ["斯威士兰 / 史瓦蒂尼 / 斯威士蘭", "斯威士兰"],
    ["东京都/東京都", "东京都"],
    ["东京都／東京都", "东京都"],
    ["甲；乙", "甲"],
    ["甲\r\n乙", "甲"],
    [" ; \t; 伦敦 ; 倫敦 ", "伦敦"],
    [" \t\r\n", ""],
    ["𠮷野;吉野", "𠮷野"],
    ["甲;;乙;丙", "甲;乙"],
  ])("chooses the first nonempty alternative in %s", (value, expected) => {
    expect(mapLabel({ "name:zh": value })).toBe(expected);
  });

  it.each([
    "New York",
    "Saint-Étienne",
    "Frankfurt (Oder)",
    "AC/DC",
    "A / B",
    "東京",
    "臺北",
    "የሐረሪ ክልል",
    "北京大学（东门）",
    "北京/上海服务区",
    "R&D",
    "甲;;乙",
  ])("preserves punctuation and local scripts in %s", (name) => {
    expect(mapLabel({ name })).toBe(name.replace(";;", ";"));
  });

  it("recognizes bilingual slashes only with independent language evidence", () => {
    expect(
      mapLabel({
        name: "የሐረሪ ክልል / Harari Region",
        "name:en": "Harari Region",
      }),
    ).toBe("Harari Region");
    expect(
      mapLabel({ name: "New Zealand / Aotearoa", "name:mi": "Aotearoa" }),
    ).toBe("New Zealand");
    expect(mapLabel({ name: "AC/DC", "name:en": "AC/DC" })).toBe("AC/DC");
  });

  it("skips missing, blank and invalid candidates without stringifying them", () => {
    expect(
      mapLabel({
        "name:zh-Hans": 123,
        "name:zh": "  ",
        "name:zh-Hant": null,
        name: false,
        "name:en": "",
        "name:latin": " Tokyo ",
      }),
    ).toBe("Tokyo");
    expect(mapLabel({})).toBe("");
    expect(mapLabel({ name: "; ； \n" })).toBe("");
  });

  it("keeps priority and does not modify the source properties", () => {
    const properties = Object.freeze({
      "name:zh-Hans": "北京",
      "name:zh": "北京市",
      name: "Beijing",
    });
    expect(mapLabel(properties)).toBe("北京");
    expect(properties["name:zh"]).toBe("北京市");
  });
});
