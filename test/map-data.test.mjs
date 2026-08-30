import assert from "node:assert/strict";
import test from "node:test";
import { gymFeatureCollection, markerOffsets } from "../src/map-data.ts";

const source = { url: "https://example.com/", checkedAt: "2026-08-30" };
const gym = (id, contractRoute) => ({
  id,
  name: id,
  brand: "TEST BRAND",
  contractRoute,
  address: "東京都千代田区",
  location: { longitude: 139.77, latitude: 35.68 },
  fees: [{ label: "都度", yen: 500 }],
  eligibilitySource: source,
  facilitySource: source,
});

test("map features keep catalog coordinates while co-located pins receive display offsets", () => {
  const gyms = [gym("a", "konami-affiliate"), gym("b", "central-series")];
  const features = gymFeatureCollection(gyms, markerOffsets(gyms), "b").features;
  assert.deepEqual(features.map(({ geometry }) => geometry.coordinates), [[139.77, 35.68], [139.77, 35.68]]);
  assert.notDeepEqual(features[0].properties.offset, features[1].properties.offset);
  assert.deepEqual(features.map(({ properties }) => properties.brand), ["TEST BRAND", "TEST BRAND"]);
  assert.deepEqual(features.map(({ properties }) => properties.selected), [false, true]);
});
