import { createHash } from "node:crypto";
import * as cheerio from "cheerio";

export const URLS = Object.freeze({
  healthpia: "https://www.its-kenpo.or.jp/shisetsu/recreation/sports_club/healthpia.html",
  konamiIts: "https://www.its-kenpo.or.jp/shisetsu/recreation/sports_club/konami.html",
  konamiFacilities: "https://www.konami.com/sportsclub/api/facilities.php",
  konamiAlliance: "https://www.konami.com/sportsclub/BtoB/alliance/",
  centralIts: "https://www.its-kenpo.or.jp/shisetsu/recreation/sports_club/central.html",
  centralIndex: "https://business.central.co.jp/corporate/system/club/clublist/",
});

const ALLOWED_HOSTS = new Set([
  "www.its-kenpo.or.jp",
  "www.konami.com",
  "business.central.co.jp",
  "nominatim.openstreetmap.org",
]);

export const CENTRAL_AREAS = [
  "hokkaido", "aomori", "iwate", "miyagi", "akita", "yamagata", "fukushima",
  "ibaraki", "tochigi", "gunma", "saitama", "chiba", "tokyo", "kanagawa",
  "niigata", "toyama", "ishikawa", "fukui", "yamanashi", "nagano", "gifu",
  "shizuoka", "aichi", "mie", "shiga", "kyouto", "oosaka", "hyougo",
  "nara", "wakayama", "tottori", "shimane", "okayama", "hiroshima",
  "yamaguchi", "tokushima", "kagawa", "ehime", "kouchi", "fukuoka", "saga",
  "nagasaki", "kumamoto", "ooita", "miyazaki", "kagoshima", "okinawa",
];

const PREFECTURES = {
  hokkaido: "北海道", aomori: "青森県", iwate: "岩手県", miyagi: "宮城県",
  akita: "秋田県", yamagata: "山形県", fukushima: "福島県", ibaraki: "茨城県",
  tochigi: "栃木県", gunma: "群馬県", saitama: "埼玉県", chiba: "千葉県",
  tokyo: "東京都", kanagawa: "神奈川県", niigata: "新潟県", toyama: "富山県",
  ishikawa: "石川県", fukui: "福井県", yamanashi: "山梨県", nagano: "長野県",
  gifu: "岐阜県", shizuoka: "静岡県", aichi: "愛知県", mie: "三重県",
  shiga: "滋賀県", kyouto: "京都府", oosaka: "大阪府", hyougo: "兵庫県",
  nara: "奈良県", wakayama: "和歌山県", tottori: "鳥取県", shimane: "島根県",
  okayama: "岡山県", hiroshima: "広島県", yamaguchi: "山口県", tokushima: "徳島県",
  kagawa: "香川県", ehime: "愛媛県", kouchi: "高知県", fukuoka: "福岡県",
  saga: "佐賀県", nagasaki: "長崎県", kumamoto: "熊本県", ooita: "大分県",
  miyazaki: "宮崎県", kagoshima: "鹿児島県", okinawa: "沖縄県",
};

const BRAND_ALIASES = [
  [/セントラル(?:スポーツ|ウェルネス|フィットネス)/, "セントラルスポーツ"],
  [/ゴールドジム/i, "ゴールドジム"],
  [/イトマンスポーツ/, "イトマンスポーツ"],
  [/スポーツアカデミー/, "スポーツアカデミー"],
  [/メガロス/, "メガロス"],
  [/ルネサンス/, "ルネサンス"],
  [/ティップネス/, "ティップネス"],
];

export function normalizeText(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function parseYen(value) {
  const match = normalizeText(value).match(/[¥￥]?\s*([\d,]+)\s*円?/);
  if (!match) throw new Error(`Unknown fee: ${normalizeText(value) || "(empty)"}`);
  return Number(match[1].replaceAll(",", ""));
}

export function classifyBrand(name, route) {
  if (route === "healthpia") return "へるすぴあ";
  if (route === "konami-direct") return "コナミスポーツクラブ";
  return BRAND_ALIASES.find(([pattern]) => pattern.test(name))?.[1] ?? "その他";
}

export function stableId(route, providerKey, name = "", address = "") {
  const key = normalizeText(providerKey) || `${normalizeText(name)}|${normalizeText(address)}`;
  if (!key) throw new Error("Stable id requires a provider key or name and address");
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return `${route}:${hash}`;
}

export async function fetchOfficial(url, fetcher = fetch) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`Unapproved catalog host: ${parsed.hostname}`);
  }
  const response = await fetcher(parsed, {
    headers: { "User-Agent": "its-gym-map/1.0 (deterministic catalog updater)" },
  });
  if (!response.ok) throw new Error(`Fetch failed ${response.status}: ${url}`);
  return response.text();
}

function source(url, checkedAt) {
  return { url, checkedAt };
}

export function parseHealthpia(html, checkedAt) {
  const $ = cheerio.load(html);
  const heading = normalizeText($("#contents h1").first().text());
  const addressCell = $("#contents th").filter((_, node) => normalizeText($(node).text()) === "所在地").first().next("td");
  const feeCell = $("#contents th").filter((_, node) => normalizeText($(node).text()) === "利用料金").first().next("td");
  if (!heading.includes("へるすぴあ") || !addressCell.length || !feeCell.length) {
    throw new Error("Unknown Healthpia page structure");
  }
  const address = normalizeText(addressCell.text().replace(/TEL.*$/i, ""));
  const feeText = feeCell.html()?.replace(/<br\s*\/?\s*>/gi, "\n") ?? "";
  const fees = [...cheerio.load(`<div>${feeText}</div>`)("div").text().matchAll(/(平日|土・日・祝日)\s*([\d,]+)円/g)]
    .map((match) => ({ label: match[1], yen: parseYen(match[2]) }));
  if (!address || fees.length !== 2) throw new Error("Unknown Healthpia address or fees");
  return [{
    id: stableId("healthpia", "healthpia"),
    name: heading,
    brand: classifyBrand(heading, "healthpia"),
    contractRoute: "healthpia",
    address,
    fees,
    eligibilitySource: source(URLS.healthpia, checkedAt),
    facilitySource: source(URLS.healthpia, checkedAt),
  }];
}

function exactMap(entries, expectedKeys, label) {
  const result = new Map(entries);
  if (result.size !== expectedKeys.length || expectedKeys.some((key) => !result.has(key))) {
    throw new Error(`Unknown ${label} fee table`);
  }
  return result;
}

export function parseKonamiItsFees(html) {
  const $ = cheerio.load(html);
  const direct = [];
  const affiliate = [];
  $("#contents table tr").each((_, row) => {
    const cells = $(row).children("td");
    if (cells.length !== 2) return;
    const label = normalizeText(cells.eq(0).text());
    const amount = parseYen(cells.eq(1).text());
    const category = label.match(/カテゴリ(IV|I{1,3})/);
    const providerFee = label.match(/^([\d,]+)円店\(提携施設\)$/);
    if (category) direct.push([category[1], amount]);
    if (providerFee) affiliate.push([parseYen(providerFee[1]), amount]);
  });
  return {
    direct: exactMap(direct, ["I", "II", "III", "IV"], "Konami category"),
    affiliate: exactMap(affiliate, [880, 1210, 1540, 1870, 2200], "Konami affiliate"),
  };
}

const ROMAN_CATEGORIES = { "1": "I", "2": "II", "3": "III", "4": "IV" };

export function parseKonamiDirect(json, feeMap, checkedAt) {
  const value = typeof json === "string" ? JSON.parse(json) : json;
  if (!Array.isArray(value?.facilities)) throw new Error("Unknown Konami facilities structure");
  return value.facilities.flatMap((facility) => {
    const category = facility?.services?.fitness?.category;
    if (category == null) return [];
    const name = normalizeText(facility.name);
    if (name.includes("グランサイズ")) return [];
    const roman = ROMAN_CATEGORIES[String(category)];
    if (!roman || !feeMap.has(roman)) throw new Error(`Unknown Konami category: ${category}`);
    const place = facility.place?.address;
    const address = normalizeText(`${place?.prefecture ?? ""}${place?.municipality ?? ""}${place?.blockNumber ?? ""}${place?.buildingsEtc ?? ""}`);
    if (!name || !address || !normalizeText(facility.code)) throw new Error("Incomplete Konami facility");
    const latitude = facility.place?.geographicCoordinates?.latitude;
    const longitude = facility.place?.geographicCoordinates?.longitude;
    return [{
      id: stableId("konami-direct", facility.code),
      name,
      brand: classifyBrand(name, "konami-direct"),
      contractRoute: "konami-direct",
      address,
      fees: [{ label: `カテゴリ${roman}`, yen: feeMap.get(roman) }],
      sourceLocation: Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : undefined,
      eligibilitySource: source(URLS.konamiIts, checkedAt),
      facilitySource: source(URLS.konamiFacilities, checkedAt),
    }];
  });
}

export function parseKonamiAffiliates(html, feeMap, checkedAt) {
  const $ = cheerio.load(html);
  const records = [];
  $("table.styleTable tbody tr").each((_, row) => {
    const cells = $(row).children("td");
    if (cells.length < 4) return;
    const aPrice = cells.eq(1).find(".aPri");
    if (!aPrice.length) return;
    const name = normalizeText(cells.eq(0).text());
    const originalFee = parseYen(aPrice.text());
    const prefecture = normalizeText($(row).closest(".tabBox").find("h2").first().text());
    const localAddress = normalizeText(cells.eq(3).find(".iconLocation").text());
    const address = localAddress.startsWith(prefecture) ? localAddress : `${prefecture}${localAddress}`;
    const yen = feeMap.get(originalFee);
    if (!name || !prefecture || !localAddress) throw new Error("Incomplete Konami affiliate");
    if (yen == null) throw new Error(`Unknown Konami affiliate fee: ${originalFee}`);
    records.push({
      id: stableId("konami-affiliate", "", name, address),
      name,
      brand: classifyBrand(name, "konami-affiliate"),
      contractRoute: "konami-affiliate",
      address,
      fees: [{ label: "気軽に都度利用(A)", yen }],
      eligibilitySource: source(URLS.konamiIts, checkedAt),
      facilitySource: source(URLS.konamiAlliance, checkedAt),
    });
  });
  if (!records.length) throw new Error("No Konami affiliates found");
  return records;
}

export function parseCentralItsFees(html) {
  const $ = cheerio.load(html);
  const entries = [];
  $("#contents table tr").each((_, row) => {
    const cells = $(row).children("td");
    if (cells.length !== 2) return;
    const label = normalizeText(cells.eq(0).text());
    if (!/^\d[\d,]*円店$/.test(label)) return;
    entries.push([parseYen(label), parseYen(cells.eq(1).text())]);
  });
  return exactMap(entries, [770, 1320, 1870, 2420], "Central" );
}

export function collectCentralAreaUrls(html, expected = CENTRAL_AREAS) {
  const $ = cheerio.load(html);
  const byArea = new Map();
  $('a[href*="area=club_"]').each((_, link) => {
    const url = new URL($(link).attr("href"), URLS.centralIndex);
    const area = url.searchParams.get("area")?.replace(/^club_/, "");
    if (area) byArea.set(area, url.href);
  });
  const missing = expected.filter((area) => !byArea.has(area));
  if (missing.length) throw new Error(`Missing Central areas: ${missing.join(", ")}`);
  return expected.map((area) => ({ area, prefecture: PREFECTURES[area], url: byArea.get(area) }));
}

function definitionValue($, root, label) {
  return normalizeText(root.find("dt").filter((_, node) => normalizeText($(node).text()).replaceAll(" ", "") === label).first().next("dd").clone().children().remove().end().text());
}

export function parseCentralClubs(html, { area, url, feeMap, checkedAt }) {
  const prefecture = PREFECTURES[area];
  if (!prefecture) throw new Error(`Unknown Central area: ${area}`);
  const $ = cheerio.load(html);
  const records = [];
  $("h5.page__title--club").each((_, heading) => {
    const name = normalizeText($(heading).text());
    const block = $(heading).nextAll(".club-area__list").first();
    const localAddress = definitionValue($, block, "住所");
    const originalFee = parseYen(definitionValue($, block, "利用料"));
    const address = localAddress.startsWith(prefecture) ? localAddress : `${prefecture}${localAddress}`;
    const yen = feeMap.get(originalFee);
    if (!name || !localAddress) throw new Error("Incomplete Central facility");
    if (yen == null) throw new Error(`Unknown Central fee: ${originalFee}`);
    records.push({
      id: stableId("central-series", "", name, address),
      name,
      brand: classifyBrand(name, "central-series"),
      contractRoute: "central-series",
      address,
      fees: [{ label: "都度利用", yen }],
      eligibilitySource: source(URLS.centralIts, checkedAt),
      facilitySource: source(url, checkedAt),
    });
  });
  return records;
}
