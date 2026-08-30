import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  classifyBrand,
  collectCentralAreaUrls,
  parseCentralClubs,
  parseCentralItsFees,
  parseHealthpia,
  parseKonamiAffiliates,
  parseKonamiDirect,
  parseKonamiItsFees,
  stableId,
} from "../scripts/catalog-lib.mjs";

const fixture = (name) => readFile(new URL(`fixtures/${name}`, import.meta.url), "utf8");
const checkedAt = "2026-08-30";
const [healthpiaHtml, konamiItsHtml, directJson, allianceHtml, centralItsHtml, centralIndexHtml, centralHtml] = await Promise.all([
  fixture("healthpia.html"), fixture("konami-its.html"), fixture("konami-direct.json"),
  fixture("konami-alliance.html"), fixture("central-its.html"), fixture("central-index.html"),
  fixture("central-hokkaido.html"),
]);

test("same source input is deterministic", () => {
  assert.deepEqual(parseHealthpia(healthpiaHtml, checkedAt), parseHealthpia(healthpiaHtml, checkedAt));
});

test("Healthpia produces one record with weekday fees and sources", () => {
  const [gym] = parseHealthpia(healthpiaHtml, checkedAt);
  assert.deepEqual(gym.fees, [{ label: "平日", yen: 1000 }, { label: "土・日・祝日", yen: 1300 }]);
  assert.equal(gym.address, "東京都板橋区坂下1-33-12");
  assert.equal(gym.eligibilitySource.checkedAt, checkedAt);
});

test("Konami direct maps categories and excludes GranSize", () => {
  const fees = parseKonamiItsFees(konamiItsHtml);
  const gyms = parseKonamiDirect(directJson, fees.direct, checkedAt);
  assert.equal(gyms.length, 1);
  assert.equal(gyms[0].fees[0].yen, 1200);
  assert.ok(!gyms.some(({ name }) => name.includes("グランサイズ")));
});

test("Konami affiliates only use plan A and map the member fee", () => {
  const fees = parseKonamiItsFees(konamiItsHtml);
  const gyms = parseKonamiAffiliates(allianceHtml, fees.affiliate, checkedAt);
  assert.equal(gyms.length, 1);
  assert.equal(gyms[0].fees[0].yen, 1200);
  assert.match(gyms[0].address, /^北海道/);
});

test("Central links are deduplicated and missing areas are rejected", () => {
  assert.equal(collectCentralAreaUrls(centralIndexHtml, ["hokkaido"]).length, 1);
  assert.throws(() => collectCentralAreaUrls(centralIndexHtml, ["hokkaido", "aomori"]), /Missing Central areas/);
});

test("Central clubs use explicit ITS fee mapping and reject unknown fees", () => {
  const fees = parseCentralItsFees(centralItsHtml);
  const options = { area: "hokkaido", url: "https://business.central.co.jp/corporate/system/club/clublist/?area=club_hokkaido", feeMap: fees, checkedAt };
  const [gym] = parseCentralClubs(centralHtml, options);
  assert.equal(gym.fees[0].yen, 930);
  assert.equal(gym.brand, "セントラルスポーツ");
  assert.throws(() => parseCentralClubs(centralHtml.replace("1,870円", "9,999円"), options), /Unknown Central fee/);
  assert.deepEqual(parseCentralClubs("<p>対象施設はありません</p>", options), []);
});

test("brand aliases are explicit and stable ids retain contract routes", () => {
  assert.equal(classifyBrand("名称未登録ジム", "konami-affiliate"), "その他");
  assert.notEqual(stableId("konami-affiliate", "same"), stableId("central-series", "same"));
});

test("catalog code and dependencies contain no AI service", async () => {
  const [pkg, source] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/catalog-lib.mjs", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(pkg, /openai|anthropic|gemini|langchain/i);
  assert.doesNotMatch(source, /api\.openai|anthropic\.com|generativelanguage/i);
  assert.throws(() => parseKonamiItsFees(konamiItsHtml.replace("2,200円店(提携施設)", "2,300円店(提携施設)")), /Unknown Konami affiliate fee table/);
});
