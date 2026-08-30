import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseCatalog } from "../src/catalog.ts";

const sample = JSON.parse(await readFile(new URL("../public/gyms.json", import.meta.url)));

test("catalog accepts valid records and preserves same-location routes", () => {
  parseCatalog(sample);
  const first = structuredClone(sample.gyms[0]);
  const shared = parseCatalog({
    ...sample,
    gyms: [
      { ...first, id: "konami-affiliate:demo", contractRoute: "konami-affiliate" },
      { ...first, id: "central-series:demo", contractRoute: "central-series" },
    ],
  }).gyms;
  assert.equal(shared.length, 2);
  assert.notEqual(shared[0].id, shared[1].id);
  assert.deepEqual(shared[0].location, shared[1].location);
});

test("catalog rejects a missing required field", () => {
  const invalid = structuredClone(sample);
  delete invalid.gyms[0].address;
  assert.throws(() => parseCatalog(invalid), /Invalid gym catalog/);
});
