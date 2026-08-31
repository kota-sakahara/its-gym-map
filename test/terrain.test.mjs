import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
const terrain = source.slice(source.indexOf("function syncTerrain"), source.indexOf('map.on("pitch"'));
const styleLoad = source.slice(source.indexOf('map.on("style.load"'), source.indexOf("map.addControl"));

test("terrain is loaded lazily and follows 3D state across style reloads", () => {
  assert.match(terrain, /map\.setTerrain\(null\)/);
  assert.match(terrain, /type: "raster-dem"/);
  assert.match(terrain, /type: "hillshade"/);
  assert.match(terrain, /"hillshade-highlight-color": colors\.highlight/);
  assert.match(terrain, /setLayoutProperty\(TERRAIN_HILLSHADE_LAYER, "visibility", "none"\)/);
  assert.match(terrain, /map\.setTerrain\(\{ source: TERRAIN_SOURCE, exaggeration: TERRAIN_EXAGGERATION \}\)/);
  assert.match(styleLoad, /syncTerrain\(is3d\)/);
  assert.match(source, /const TERRAIN_EXAGGERATION = 4;/);
  assert.match(source, /const TERRAIN_PITCH = 65;/);
  assert.match(terrain, /shadow: "#020b10", highlight: "#92abb0", accent: "#31535b"/);
});
