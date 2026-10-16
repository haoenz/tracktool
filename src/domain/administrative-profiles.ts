import type {
  AdministrativeField,
  GeocodeResult,
} from "../shared/endpoint-location.js";
export const ADMINISTRATIVE_FIELDS: AdministrativeField[] = [
  "country",
  "province",
  "city",
  "district",
];
export const normalizedName = (value: string) =>
  value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en")
    .replace(/[\s\p{P}]/gu, "");
export type Binding = {
  name: string;
  aliases: string[];
  type: string;
  self: boolean;
  preference: number;
  resultIndex: number;
};
export type AdministrativeCandidate = {
  index: number;
  result: GeocodeResult;
  countryCode: string | null;
  bindings: Partial<Record<AdministrativeField, Binding>>;
  notApplicable: Set<AdministrativeField>;
};
// Only these named Hong Kong administrative districts may be read from neighborhood.
// Source: https://www.had.gov.hk/en/18_districts/my_map.htm
const hkDistricts = [
  "中西區",
  "中西区",
  "灣仔區",
  "湾仔区",
  "東區",
  "东区",
  "南區",
  "南区",
  "油尖旺區",
  "油尖旺区",
  "深水埗區",
  "深水埗区",
  "九龍城區",
  "九龙城区",
  "黃大仙區",
  "黄大仙区",
  "觀塘區",
  "观塘区",
  "葵青區",
  "葵青区",
  "荃灣區",
  "荃湾区",
  "屯門區",
  "屯门区",
  "元朗區",
  "元朗区",
  "北區",
  "北区",
  "大埔區",
  "大埔区",
  "沙田區",
  "沙田区",
  "西貢區",
  "西贡区",
  "離島區",
  "离岛区",
  "Central and Western",
  "Wan Chai",
  "Eastern",
  "Southern",
  "Yau Tsim Mong",
  "Sham Shui Po",
  "Kowloon City",
  "Wong Tai Sin",
  "Kwun Tong",
  "Kwai Tsing",
  "Tsuen Wan",
  "Tuen Mun",
  "Yuen Long",
  "North",
  "Tai Po",
  "Sha Tin",
  "Sai Kung",
  "Islands",
].flatMap((v) => [normalizedName(v), normalizedName(v + " District")]);
export function parseAdministrativeCandidate(
  result: GeocodeResult,
  index: number,
): AdministrativeCandidate {
  const components = result.address_components ?? [];
  const bindings: AdministrativeCandidate["bindings"] = {};
  const notApplicable = new Set<AdministrativeField>();
  const take = (
    field: AdministrativeField,
    types: string[],
    accept: (name: string) => boolean = () => true,
  ) => {
    for (const [preference, type] of types.entries()) {
      const c = components.find(
        (c) =>
          c.types.includes(type) &&
          c.long_name?.trim() &&
          accept(c.long_name.trim()),
      );
      if (!c?.long_name) continue;
      bindings[field] = {
        name: c.long_name.trim(),
        aliases: [c.long_name, c.short_name]
          .filter((v): v is string => !!v)
          .map(normalizedName),
        type,
        self: !!result.types?.includes(type),
        preference,
        resultIndex: index,
      };
      return bindings[field];
    }
    return undefined;
  };
  const countryCode =
    components
      .find((c) => c.types.includes("country"))
      ?.short_name?.toUpperCase() ?? null;
  take("country", ["country"]);
  take("province", ["administrative_area_level_1"]);
  const districtName = () => bindings.district?.name;
  if (countryCode === "CN") {
    if (
      !take(
        "district",
        ["administrative_area_level_3", "sublocality_level_1"],
        (n) => /(?:区|县|旗|市)$/.test(n),
      )
    )
      take("district", ["administrative_area_level_2", "locality"], (n) =>
        /(?:区|县|旗)$/.test(n),
      );
    take(
      "city",
      ["administrative_area_level_2", "locality"],
      (n) => n !== districtName() && /(?:市|自治州|地区|盟)$/.test(n),
    );
    const province = bindings.province;
    if (province && /^(北京|天津|上海|重庆)市?$/.test(province.name)) {
      bindings.city = {
        ...province,
        type: "municipality:administrative_area_level_1",
        self: false,
      };
    }
  } else if (countryCode === "JP") {
    take(
      "district",
      ["sublocality_level_1", "administrative_area_level_2"],
      (n) => /(?:区|區|郡|ward|district)$/i.test(n),
    );
    take("city", ["locality"]);
    // Tokyo special wards may be returned as locality instead of a city + ward.
    if (
      !bindings.district &&
      bindings.city &&
      /(?:区|區|ward)$/i.test(bindings.city.name)
    ) {
      bindings.district = bindings.city;
      delete bindings.city;
      notApplicable.add("city");
    }
  } else if (countryCode === "HK") {
    take(
      "district",
      ["administrative_area_level_2", "sublocality_level_1", "neighborhood"],
      (n) => hkDistricts.includes(normalizedName(n)),
    );
    // Region / district, without inventing a prefecture between them.
    notApplicable.add("city");
  } else if (countryCode === "SG") {
    take("city", ["locality"]);
    // Planning areas/neighborhoods are retained in raw data, not called provinces/counties.
    notApplicable.add("province");
    notApplicable.add("district");
  } else if (countryCode === "KR") {
    take("city", ["locality"]);
    take(
      "district",
      ["sublocality_level_1", "administrative_area_level_2"],
      (n) => /(?:구|군|区|區|郡|[- ]gu|[- ]gun|District)$/i.test(n),
    );
    // Metropolitan cities govern gu/gun directly, without an intermediate city.
    // https://english.seoul.go.kr/seoul-views/meaning-of-seoul/2-location/
    if (
      !bindings.city &&
      bindings.province &&
      (/广域市|廣域市|광역시|특별시|Metropolitan City|Special City/i.test(
        bindings.province.name,
      ) ||
        [
          "Seoul",
          "首尔",
          "首爾",
          "서울",
          "Busan",
          "Incheon",
          "Daegu",
          "Daejeon",
          "Gwangju",
          "Ulsan",
        ]
          .map(normalizedName)
          .includes(normalizedName(bindings.province.name)))
    )
      notApplicable.add("city");
    // Jeju's two administrative cities subdivide directly into eup/myeon/dong, not gu.
    // https://www.investkorea.org/jj-en/cntnts/i-1491/web.do
    const jejuProvinces = [
      "Jeju-do",
      "济州特别自治道",
      "济州道",
      "제주특별자치도",
      "제주도",
    ].map(normalizedName);
    const jejuCities = [
      "Cheju",
      "Jeju",
      "Jeju-si",
      "济州市",
      "제주시",
      "Seogwipo",
      "Seogwipo-si",
      "西归浦市",
      "서귀포시",
    ].map(normalizedName);
    if (
      !bindings.district &&
      bindings.province &&
      bindings.city &&
      jejuProvinces.includes(normalizedName(bindings.province.name)) &&
      jejuCities.includes(normalizedName(bindings.city.name))
    )
      notApplicable.add("district");
  } else if (countryCode === "TH") {
    take("city", ["locality"]);
    take("district", ["administrative_area_level_2", "sublocality_level_1"]);
    const province = bindings.province;
    if (
      !bindings.city &&
      province &&
      [
        "bangkok",
        "krungthepmahanakhon",
        "曼谷",
        "曼谷都会区",
        "曼谷都會區",
      ].includes(normalizedName(province.name))
    ) {
      bindings.city = {
        ...province,
        type: "municipality:administrative_area_level_1",
        self: false,
      };
    }
  } else if (countryCode === "MY") {
    // State -> administrative district; settlements are retained in raw components.
    // https://www.dosm.gov.my/portal-main/links/regional-classifications
    take("district", [
      "administrative_area_level_3",
      "administrative_area_level_2",
    ]);
    notApplicable.add("city");
  } else if (countryCode === "TR") {
    take("district", [
      "administrative_area_level_2",
      "administrative_area_level_3",
    ]);
    notApplicable.add("city");
  } else {
    take("city", ["locality", "postal_town"]);
    take("district", [
      "administrative_area_level_2",
      "administrative_area_level_3",
    ]);
  }
  if (countryCode === "HK" && bindings.province) {
    // https://www.census2021.gov.hk/en/district_profiles.html
    for (const names of [
      ["New Territories", "新界"],
      ["Hong Kong Island", "香港岛", "香港島"],
      ["Kowloon", "九龙", "九龍"],
    ]) {
      const aliases = names.map(normalizedName);
      if (bindings.province.aliases.some((a) => aliases.includes(a)))
        bindings.province.aliases = [
          ...new Set([...bindings.province.aliases, ...aliases]),
        ];
    }
  }
  if (countryCode === "TH") {
    const bangkok = [
      "bangkok",
      "krungthepmahanakhon",
      "曼谷",
      "曼谷都会区",
      "曼谷都會區",
    ].map(normalizedName);
    for (const field of ["province", "city"] as const) {
      const b = bindings[field];
      if (b && b.aliases.some((a) => bangkok.includes(a)))
        b.aliases = [...new Set([...b.aliases, ...bangkok])];
    }
  }
  return { index, result, countryCode, bindings, notApplicable };
}
export function sameBinding(a: Binding, b: Binding) {
  return a.aliases.some((value) => b.aliases.includes(value));
}
