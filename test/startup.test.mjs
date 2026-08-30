import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
const start = source.slice(source.indexOf("async function start()"), source.indexOf("const BRIEFING_KEY"));

test("catalog rendering does not wait for map style or geolocation", () => {
  assert.doesNotMatch(start, /await .*style\.load/);
  assert.ok(start.indexOf('setReference(TOKYO_STATION, "tokyo", true)') < start.indexOf("await locationPromise"));
});
