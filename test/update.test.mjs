import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addressMatches, geocodeRecords, validateGeocodeOverrides } from "../scripts/geocode.mjs";
import { updateCatalog, validateCatalogUpdate } from "../scripts/update-catalog.mjs";

const source = { url: "https://example.com/source", checkedAt: "2026-08-30" };
const raw = {
  id: "healthpia:one", name: "施設", brand: "へるすぴあ", contractRoute: "healthpia",
  address: "東京都板橋区坂下1-33-12", fees: [{ label: "平日", yen: 1000 }],
  eligibilitySource: source, facilitySource: source,
};

test("cached and manually fixed coordinates never call the geocoder", async () => {
  let calls = 0;
  const cache = { schemaVersion: 1, entries: {
    [raw.address]: { latitude: 35.7, longitude: 139.7, source: "manual" },
  } };
  const result = await geocodeRecords([raw], cache, { fetcher: async () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.deepEqual(result.gyms[0].location, { longitude: 139.7, latitude: 35.7 });
});

test("official coordinates are cached without calling a geocoder", async () => {
  let calls = 0;
  const result = await geocodeRecords([{ ...raw, sourceLocation: { latitude: 35.2, longitude: 139.3 } }], { schemaVersion: 1, entries: {} }, { fetcher: async () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.equal(result.cache.entries[raw.address].source, "official");
});

test("GSI geocodes new addresses once and the cache prevents another call", async () => {
  let calls = 0;
  const fetcher = async () => ({ ok: true, json: async () => [{ properties: { title: "東京都板橋区坂下1丁目33番12号" }, geometry: { coordinates: [139.2, 35.1] } }] });
  const first = await geocodeRecords([raw], { schemaVersion: 1, entries: {} }, { fetcher: async (...args) => { calls += 1; return fetcher(...args); }, gsiDelayMs: 0 });
  await geocodeRecords([raw], first.cache, { fetcher: async () => { calls += 1; }, gsiDelayMs: 0 });
  assert.equal(calls, 1);
  assert.equal(first.cache.entries[raw.address].source, "gsi");
});

test("unverified GSI and Nominatim results are rejected", async () => {
  const fetcher = async (url) => ({ ok: true, json: async () => url.hostname === "msearch.gsi.go.jp"
    ? [{ properties: { title: "東京都板橋区高島平1丁目" }, geometry: { coordinates: [139.2, 35.1] } }]
    : [{ display_name: "高島平, 板橋区, 東京都, 日本", lat: "35.1", lon: "139.2", address: { province: "東京都", city: "板橋区", quarter: "高島平" } }] });
  await assert.rejects(() => geocodeRecords([raw], { schemaVersion: 1, entries: {} }, { fetcher, gsiDelayMs: 0, nominatimDelayMs: 0 }), (error) => {
    assert.equal(error.geocodeFailures[0].name, raw.name);
    assert.equal(error.geocodeFailures[0].attempts[0].candidates[0].label, "東京都板橋区高島平1丁目");
    assert.equal(error.geocodeFailures[0].attempts[0].candidates[0].reason, "address-components-mismatch");
    return /No verified geocoding result/.test(error.message);
  });
  assert.equal(addressMatches(raw.address, "東京都板橋区坂下1丁目33番12号"), true);
  assert.equal(addressMatches("青森県三沢市三沢字下久保57-3", "青森県三沢市大字三沢下久保57番地"), true);
  assert.equal(addressMatches("千葉県長生郡長柄町上野521-4", "千葉県長柄町上野"), true);
  assert.equal(addressMatches("福島県郡山市西ノ内2-11-35 西部プラザ2階", "福島県郡山市西ノ内二丁目11番35号"), true);
  assert.equal(addressMatches(raw.address, "東京都板橋区高島平1丁目"), false);
});

test("auditable overrides preserve the provider address", async () => {
  const overrides = { schemaVersion: 1, entries: {
    [raw.address]: {
      queryAddress: "東京都板橋区坂下1丁目33番12号",
      evidenceUrl: source.url,
      checkedAt: source.checkedAt,
      reason: "住居表示へ補正",
    },
  } };
  let query;
  const result = await geocodeRecords([raw], { schemaVersion: 1, entries: {} }, {
    overrides,
    fetcher: async (url) => {
      query = url.searchParams.get("q");
      return { ok: true, json: async () => [{ properties: { title: query }, geometry: { coordinates: [139.2, 35.1] } }] };
    },
  });
  assert.equal(query, overrides.entries[raw.address].queryAddress);
  assert.equal(result.gyms[0].address, raw.address);
  assert.throws(() => validateGeocodeOverrides({ schemaVersion: 1, entries: { [raw.address]: { ...overrides.entries[raw.address], reason: "" } } }), /Invalid geocode override/);
});

test("geocoders stay within their request-rate limits", async () => {
  const records = [raw, { ...raw, id: "healthpia:two", address: "東京都板橋区成増1-1-1" }];
  const gsiStarts = [];
  await geocodeRecords(records, { schemaVersion: 1, entries: {} }, { fetcher: async (url) => {
    gsiStarts.push(performance.now());
    const title = url.searchParams.get("q");
    return { ok: true, json: async () => [{ properties: { title }, geometry: { coordinates: [139.2, 35.1] } }] };
  } });
  assert.ok(gsiStarts[1] - gsiStarts[0] >= 45);

  const nominatimStarts = [];
  await geocodeRecords(records, { schemaVersion: 1, entries: {} }, { gsiDelayMs: 0, fetcher: async (url) => {
    if (url.hostname === "msearch.gsi.go.jp") return { ok: true, json: async () => [] };
    nominatimStarts.push(performance.now());
    const display_name = url.searchParams.get("q");
    return { ok: true, json: async () => [{ display_name, lat: "35.1", lon: "139.2", address: {} }] };
  } });
  assert.ok(nominatimStarts[1] - nominatimStarts[0] >= 1000);
});

test("validation rejects missing routes and abrupt count drops", () => {
  const gym = { ...raw, location: { longitude: 139.7, latitude: 35.7 } };
  const allRoutes = ["healthpia", "konami-direct", "konami-affiliate", "central-series"];
  const catalog = { schemaVersion: 1, generatedAt: "2026-08-30T00:00:00Z", gyms: allRoutes.map((contractRoute, index) => ({ ...gym, id: `${contractRoute}:${index}`, contractRoute })) };
  assert.doesNotThrow(() => validateCatalogUpdate(catalog));
  assert.throws(() => validateCatalogUpdate({ ...catalog, gyms: catalog.gyms.slice(1) }), /No records/);
  const previous = { ...catalog, gyms: allRoutes.flatMap((contractRoute) => Array.from({ length: 10 }, (_, index) => ({ ...gym, id: `${contractRoute}:old-${index}`, contractRoute }))) };
  assert.throws(() => validateCatalogUpdate(catalog, previous), /Suspicious record drop/);
});

test("fetch failure leaves the public catalog and checked date unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "its-gym-map-test-"));
  const catalogPath = join(directory, "gyms.json");
  const cachePath = join(directory, "cache.json");
  const beforeCatalog = '{"checkedAt":"unchanged"}\n';
  const beforeCache = '{"schemaVersion":1,"entries":{}}\n';
  await Promise.all([writeFile(catalogPath, beforeCatalog), writeFile(cachePath, beforeCache)]);
  await assert.rejects(() => updateCatalog({ catalogPath, cachePath, fetcher: async () => { throw new Error("offline"); } }), /offline/);
  assert.equal(await readFile(catalogPath, "utf8"), beforeCatalog);
  assert.equal(await readFile(cachePath, "utf8"), beforeCache);
  await rm(directory, { recursive: true });
});

test("geocode failure writes reusable private artifacts and success promotes the cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "its-gym-map-geocode-"));
  const catalogPath = join(directory, "gyms.json");
  const cachePath = join(directory, "cache.json");
  const overridesPath = join(directory, "overrides.json");
  const pendingCachePath = join(directory, "pending.json");
  const failurePath = join(directory, "failures.json");
  const beforeCatalog = '{"checkedAt":"unchanged"}\n';
  const beforeCache = '{"schemaVersion":1,"entries":{}}\n';
  const routes = ["healthpia", "konami-direct", "konami-affiliate", "central-series"];
  const records = routes.map((contractRoute, index) => ({
    ...raw,
    id: `${contractRoute}:${index}`,
    contractRoute,
    address: `東京都板橋区坂下${index + 1}-1-1`,
    ...(index < 3 ? { sourceLocation: { latitude: 35.7 + index / 100, longitude: 139.7 + index / 100 } } : {}),
  }));
  await Promise.all([
    writeFile(catalogPath, beforeCatalog),
    writeFile(cachePath, beforeCache),
    writeFile(overridesPath, '{"schemaVersion":1,"entries":{}}\n'),
  ]);
  await assert.rejects(() => updateCatalog({
    catalogPath, cachePath, overridesPath, pendingCachePath, failurePath, records,
    fetcher: async () => ({ ok: true, json: async () => [] }),
  }), /No verified geocoding result/);
  assert.equal(await readFile(catalogPath, "utf8"), beforeCatalog);
  assert.equal(await readFile(cachePath, "utf8"), beforeCache);
  const pending = JSON.parse(await readFile(pendingCachePath, "utf8"));
  const report = JSON.parse(await readFile(failurePath, "utf8"));
  assert.equal(Object.keys(pending.entries).length, 3);
  assert.deepEqual(report.failures[0], {
    id: records[3].id,
    name: raw.name,
    contractRoute: records[3].contractRoute,
    address: records[3].address,
    facilitySource: source,
    attempts: [
      { provider: "gsi", reason: "no-results", candidates: [] },
      { provider: "nominatim", reason: "no-results", candidates: [] },
    ],
  });

  await writeFile(overridesPath, `${JSON.stringify({ schemaVersion: 1, entries: {
    [records[3].address]: {
      location: { latitude: 35.73, longitude: 139.73 },
      evidenceUrl: source.url,
      checkedAt: source.checkedAt,
      reason: "公式施設ページで確認",
    },
  } })}\n`);
  const catalog = await updateCatalog({
    catalogPath, cachePath, overridesPath, pendingCachePath, failurePath, records,
    fetcher: async () => { throw new Error("geocoder must not be called"); },
  });
  assert.equal(catalog.gyms.length, 4);
  assert.equal(catalog.gyms[3].address, records[3].address);
  assert.equal(Object.keys(JSON.parse(await readFile(cachePath, "utf8")).entries).length, 4);
  await assert.rejects(() => readFile(pendingCachePath), { code: "ENOENT" });
  await assert.rejects(() => readFile(failurePath), { code: "ENOENT" });
  await rm(directory, { recursive: true });
});
