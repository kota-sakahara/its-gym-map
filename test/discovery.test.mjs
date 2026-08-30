import assert from "node:assert/strict";
import test from "node:test";
import maplibregl from "maplibre-gl";
import { filterGyms, isDataStale, normalizeSearch, rankGyms } from "../src/discovery.ts";

const source = { url: "https://example.com/", checkedAt: "2026-08-30" };
const gym = (overrides = {}) => ({
  id: "konami-affiliate:a",
  name: "テスト GYM",
  brand: "ブランドA",
  contractRoute: "konami-affiliate",
  address: "東京都 千代田区",
  location: { longitude: 139.77, latitude: 35.68 },
  fees: [{ label: "A", yen: 440 }, { label: "B", yen: 1200 }],
  eligibilitySource: source,
  facilitySource: source,
  ...overrides,
});

test("search and filters combine, including any matching fee", () => {
  const gyms = [gym(), gym({ id: "central-series:b", name: "別施設", brand: "ブランドB", fees: [{ label: "都度", yen: 930 }] })];
  assert.equal(normalizeSearch(" TEST　Gym "), "testgym");
  assert.deepEqual(filterGyms(gyms, { query: "東京 都", brand: "ブランドA", priceBand: "1000-1499" }).map(({ id }) => id), ["konami-affiliate:a"]);
  assert.equal(filterGyms(gyms, { query: "セントラル系列", brand: "ブランドA", priceBand: "" }).length, 0);
});

test("gyms are ranked using MapLibre distance", () => {
  const far = gym({ id: "far", location: { longitude: 140.5, latitude: 36 } });
  assert.deepEqual(rankGyms([far, gym()], new maplibregl.LngLat(139.77, 35.68)).map(({ id }) => id), ["konami-affiliate:a", "far"]);
});

test("data becomes stale only after seven date boundaries", () => {
  assert.equal(isDataStale("2026-08-23", new Date("2026-08-30T23:59:59Z")), false);
  assert.equal(isDataStale("2026-08-23", new Date("2026-08-31T00:00:00Z")), true);
});
