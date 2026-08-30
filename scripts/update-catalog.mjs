import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseCatalog } from "../src/catalog.ts";
import {
  URLS,
  collectCentralAreaUrls,
  fetchOfficial,
  parseCentralClubs,
  parseCentralItsFees,
  parseHealthpia,
  parseKonamiAffiliates,
  parseKonamiDirect,
  parseKonamiItsFees,
} from "./catalog-lib.mjs";
import { emptyGeocodeCache, emptyGeocodeOverrides, geocodeRecords, validateGeocodeCache, validateGeocodeOverrides } from "./geocode.mjs";

const PUBLIC_PATH = fileURLToPath(new URL("../public/gyms.json", import.meta.url));
const CACHE_PATH = fileURLToPath(new URL("../data/geocode-cache.json", import.meta.url));
const OVERRIDES_PATH = fileURLToPath(new URL("../data/geocode-overrides.json", import.meta.url));
const PENDING_CACHE_PATH = fileURLToPath(new URL("../data/geocode-cache.pending.json", import.meta.url));
const FAILURE_PATH = fileURLToPath(new URL("../data/geocode-failures.json", import.meta.url));
const ROUTES = ["healthpia", "konami-direct", "konami-affiliate", "central-series"];

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export function validateCatalogUpdate(catalog, previousCatalog) {
  parseCatalog(catalog);
  for (const route of ROUTES) {
    const count = catalog.gyms.filter((gym) => gym.contractRoute === route).length;
    if (count === 0) throw new Error(`No records for route: ${route}`);
    const previous = previousCatalog?.gyms?.filter((gym) => gym.contractRoute === route).length ?? 0;
    if (previous >= 10 && count < Math.ceil(previous * 0.7)) {
      throw new Error(`Suspicious record drop for ${route}: ${previous} -> ${count}`);
    }
  }
  return catalog;
}

export async function buildCatalog({ fetcher = fetch, cache = emptyGeocodeCache(), overrides = emptyGeocodeOverrides(), now = new Date(), records: suppliedRecords } = {}) {
  const checkedAt = now.toISOString().slice(0, 10);
  let records = suppliedRecords;
  if (!records) {
    const get = (url) => fetchOfficial(url, fetcher);
    const [healthpiaHtml, konamiItsHtml, konamiJson, allianceHtml, centralItsHtml, centralIndexHtml] = await Promise.all([
      get(URLS.healthpia), get(URLS.konamiIts), get(URLS.konamiFacilities),
      get(URLS.konamiAlliance), get(URLS.centralIts), get(URLS.centralIndex),
    ]);
    const konamiFees = parseKonamiItsFees(konamiItsHtml);
    const centralFees = parseCentralItsFees(centralItsHtml);
    const centralAreas = collectCentralAreaUrls(centralIndexHtml);
    const central = [];
    for (const area of centralAreas) {
      central.push(...parseCentralClubs(await get(area.url), {
        area: area.area, url: area.url, feeMap: centralFees, checkedAt,
      }));
    }
    records = [
      ...parseHealthpia(healthpiaHtml, checkedAt),
      ...parseKonamiDirect(konamiJson, konamiFees.direct, checkedAt),
      ...parseKonamiAffiliates(allianceHtml, konamiFees.affiliate, checkedAt),
      ...central,
    ];
  }
  const geocoded = await geocodeRecords(records, cache, { fetcher, overrides });
  return {
    catalog: { schemaVersion: 1, generatedAt: now.toISOString(), gyms: geocoded.gyms },
    cache: geocoded.cache,
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writePair(catalogPath, cachePath, catalog, cache) {
  const suffix = `${process.pid}-${Date.now()}.tmp`;
  const catalogTemp = `${catalogPath}.${suffix}`;
  const cacheTemp = `${cachePath}.${suffix}`;
  await Promise.all([
    writeFile(catalogTemp, `${JSON.stringify(catalog, null, 2)}\n`),
    writeFile(cacheTemp, `${JSON.stringify(cache, null, 2)}\n`),
  ]);
  await rename(cacheTemp, cachePath);
  await rename(catalogTemp, catalogPath);
}

export async function updateCatalog({
  catalogPath = PUBLIC_PATH,
  cachePath = CACHE_PATH,
  overridesPath = OVERRIDES_PATH,
  pendingCachePath = PENDING_CACHE_PATH,
  failurePath = FAILURE_PATH,
  fetcher = fetch,
  now = new Date(),
  records,
} = {}) {
  const previousCatalog = await readJson(catalogPath, null);
  const [existingCache, pendingCache, overrides] = await Promise.all([
    readJson(cachePath, emptyGeocodeCache()).then(validateGeocodeCache),
    readJson(pendingCachePath, emptyGeocodeCache()).then(validateGeocodeCache),
    readJson(overridesPath, emptyGeocodeOverrides()).then(validateGeocodeOverrides),
  ]);
  const mergedCache = { schemaVersion: 1, entries: { ...pendingCache.entries, ...existingCache.entries } };
  let result;
  try {
    result = await buildCatalog({ fetcher, cache: mergedCache, overrides, now, records });
  } catch (error) {
    if (error?.geocodeFailures && error?.geocodeCache) {
      await Promise.all([
        writeJson(pendingCachePath, error.geocodeCache),
        writeJson(failurePath, { schemaVersion: 1, generatedAt: now.toISOString(), failures: error.geocodeFailures }),
      ]);
    }
    throw error;
  }
  validateCatalogUpdate(result.catalog, previousCatalog);
  await writePair(catalogPath, cachePath, result.catalog, result.cache);
  await Promise.all([rm(pendingCachePath, { force: true }), rm(failurePath, { force: true })]);
  return result.catalog;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  updateCatalog().then((catalog) => {
    const counts = Object.fromEntries(ROUTES.map((route) => [route, catalog.gyms.filter((gym) => gym.contractRoute === route).length]));
    console.log(JSON.stringify({ generatedAt: catalog.generatedAt, counts }));
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
