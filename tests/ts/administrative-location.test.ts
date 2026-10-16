import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  administrativeLocation,
  reparseAdministrativeLocation,
} from "../../dist/node/domain/administrative-location.js";
import { GoogleGeocode } from "../../dist/node/infrastructure/geocode.js";
import type {
  GeocodeResponse,
  GeocodeResult,
  AddressComponent,
} from "../../dist/node/shared/endpoint-location.js";
const component = (
  type: string,
  name: string,
  short = name,
): AddressComponent => ({
  types: [type, "political"],
  long_name: name,
  short_name: short,
});
const country = component("country", "中国", "CN"),
  province = component("administrative_area_level_1", "浙江省");
const city = component("locality", "杭州市");
function district(
  name: string,
  cityValue = city,
  provinceValue = province,
): GeocodeResult {
  return {
    types: ["sublocality_level_1", "political"],
    address_components: [
      component("sublocality_level_1", name),
      cityValue,
      provinceValue,
      country,
    ],
  };
}
function fixture(name: string): GeocodeResponse {
  return JSON.parse(
    readFileSync(`tests/fixtures/geocode/${name}.json`, "utf8"),
  ) as GeocodeResponse;
}
it("selects a full localized Japanese hierarchy instead of dropping its sublocality", () => {
  const response = fixture("jp"),
    result = administrativeLocation(response.results, false, {
      rawResponse: response,
    });
  expect(result).toMatchObject({
    province: "福冈县",
    city: "福冈市",
    district: "博多区",
    status: "complete",
    raw_source: "full_response",
  });
  expect(result.raw_response).toEqual(response);
});
it("retains all candidates and chooses the explicit county instead of fabricating a parent city", () => {
  const response = fixture("cn-haikou"),
    result = administrativeLocation(response.results);
  expect(result).toMatchObject({
    province: "海南省",
    city: null,
    district: "澄迈县",
    status: "partial",
  });
  expect(result.raw_response?.results).toHaveLength(response.results.length);
  const malaysia = administrativeLocation(fixture("my").results);
  expect(malaysia).toMatchObject({
    province: "柔佛",
    city: null,
    district: "新山县",
  });
});
it("uses region-specific non-applicable levels instead of inventing three tiers", () => {
  expect(administrativeLocation(fixture("hk").results)).toMatchObject({
    province: "新界",
    city: null,
    district: "離島區",
    status: "complete",
    resolution: { fields: { city: "not_applicable" } },
  });
  expect(administrativeLocation(fixture("sg").results)).toMatchObject({
    city: "新加坡",
    province: null,
    district: null,
    status: "complete",
    resolution: {
      fields: { province: "not_applicable", district: "not_applicable" },
    },
  });
  expect(administrativeLocation(fixture("tr").results)).toMatchObject({
    province: "伊斯坦堡省",
    city: null,
    district: "阿尔纳武特柯伊",
    status: "complete",
    resolution: { fields: { city: "not_applicable" } },
  });
  expect(administrativeLocation(fixture("th").results)).toMatchObject({
    district: "Sathon",
    status: "complete",
  });
});
it("does not promote a Korean dong or invent a missing Chinese county", () => {
  expect(administrativeLocation(fixture("kr").results)).toMatchObject({
    city: "济州市",
    district: null,
    resolution: { mode: "resolved", fields: { district: "not_applicable" } },
  });
  expect(administrativeLocation(fixture("cn-haixi").results)).toMatchObject({
    province: "青海省",
    city: "海西蒙古族藏族自治州",
    district: null,
    status: "partial",
  });
});
it("automatically falls back to the common parent on conflicting district evidence", () => {
  const results = [district("西湖区"), district("上城区")];
  const result = administrativeLocation(results);
  expect(result).toMatchObject({
    province: "浙江省",
    city: "杭州市",
    district: null,
    status: "partial",
    resolution: {
      mode: "fallback",
      conflict_fields: ["district"],
      fields: { district: "conflict" },
    },
  });
  expect(administrativeLocation([...results].reverse())).toMatchObject({
    province: result.province,
    city: result.city,
    district: result.district,
  });
});
it("conflicting cities collapse to province and conflicting provinces to country", () => {
  const cityResult = (name: string) => ({
    types: ["locality", "political"],
    address_components: [component("locality", name), province, country],
  });
  expect(
    administrativeLocation([
      cityResult("杭州市"),
      cityResult("宁波市"),
      district("西湖区"),
    ]),
  ).toMatchObject({
    province: "浙江省",
    city: null,
    district: null,
    resolution: { conflict_fields: ["city"] },
  });
  const p = (name: string) => ({
    types: ["administrative_area_level_1", "political"],
    address_components: [
      component("administrative_area_level_1", name),
      country,
    ],
  });
  expect(
    administrativeLocation([p("浙江省"), p("江苏省"), district("西湖区")]),
  ).toMatchObject({
    country: "中国",
    province: null,
    city: null,
    district: null,
  });
});
it("country disagreement cannot be hidden by a detailed address or majority votes", () => {
  const other = {
    types: ["country", "political"],
    address_components: [component("country", "日本", "JP")],
  };
  expect(
    administrativeLocation([district("西湖区"), district("西湖区"), other]),
  ).toMatchObject({
    country: null,
    country_code: null,
    province: null,
    city: null,
    district: null,
    resolution: { conflict_fields: ["country"] },
  });
});
it("explicit administrative evidence outranks a conflicting nearest street component", () => {
  const weak = { ...district("上城区"), types: ["street_address"] };
  expect(administrativeLocation([weak, district("西湖区")])).toMatchObject({
    district: "西湖区",
    status: "complete",
  });
});
it("reparses legacy components without pretending they were the entire response", () => {
  const old = administrativeLocation(fixture("jp").results);
  delete old.raw_response;
  delete old.resolution;
  delete old.raw_source;
  expect(reparseAdministrativeLocation(old)).toMatchObject({
    district: "博多区",
    raw_source: "legacy_components",
    resolution: { reasons: expect.arrayContaining(["legacy_evidence_only"]) },
  });
  expect(reparseAdministrativeLocation(old).raw_response).toBeUndefined();
});
it("preserves the complete successful provider response including result metadata", async () => {
  const response = {
    ...fixture("jp"),
    plus_code: { global_code: "example" },
    results: fixture("jp").results.map((r) => ({
      ...r,
      geometry: { location: { lat: 33, lng: 130 } },
      formatted_address: "Example",
    })),
  };
  const client = new GoogleGeocode(
    async () => new Response(JSON.stringify(response)),
  );
  const value = await client.getAdministrative(
    [33, 130],
    "private-key",
    "zh-CN",
    new AbortController().signal,
  );
  expect(value.raw_response).toEqual(response);
  expect(JSON.stringify(value)).not.toContain("private-key");
});
it("does not retain a child chain when explicit parent evidence contradicts it", () => {
  const other = {
    types: ["administrative_area_level_1", "political"],
    address_components: [
      component("administrative_area_level_1", "江苏省"),
      country,
    ],
  };
  expect(administrativeLocation([district("西湖区"), other])).toMatchObject({
    country: "中国",
    province: null,
    city: null,
    district: null,
    resolution: { conflict_fields: ["province"] },
  });
});
it("ZERO_RESULTS remains empty even if a malformed response contains candidate components", () => {
  expect(administrativeLocation([district("西湖区")], true)).toMatchObject({
    country: null,
    province: null,
    city: null,
    district: null,
    status: "zero_results",
  });
});

it("recognizes metropolitan Korean districts without inventing an intermediate city", () => {
  const result = administrativeLocation([
    {
      types: ["sublocality_level_1", "political"],
      address_components: [
        component("sublocality_level_1", "Jung District"),
        component("administrative_area_level_1", "首尔"),
        component("country", "韩国", "KR"),
      ],
    },
  ]);
  expect(result).toMatchObject({
    province: "首尔",
    city: null,
    district: "Jung District",
    status: "complete",
    resolution: { fields: { city: "not_applicable" } },
  });
});

it("treats Hong Kong region translations as aliases but keeps distinct regions conflicting", () => {
  const response = fixture("hk");
  for (const name of ["New Territories", "Kowloon"]) {
    const result = administrativeLocation([
      ...response.results,
      {
        types: ["administrative_area_level_1", "political"],
        address_components: [
          component("administrative_area_level_1", name),
          component("country", "香港", "HK"),
        ],
      },
    ]);
    if (name === "New Territories") expect(result.status).toBe("complete");
    else expect(result.resolution?.conflict_fields).toContain("province");
  }
  expect(administrativeLocation(fixture("my").results)).toMatchObject({
    status: "complete",
    resolution: { fields: { city: "not_applicable" } },
  });
});
