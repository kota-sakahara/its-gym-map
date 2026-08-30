import { normalizeText } from "./catalog-lib.mjs";

export function emptyGeocodeCache() {
  return { schemaVersion: 1, entries: {} };
}

export function emptyGeocodeOverrides() {
  return { schemaVersion: 1, entries: {} };
}

export function validateGeocodeCache(cache) {
  if (cache?.schemaVersion !== 1 || typeof cache.entries !== "object" || cache.entries === null) {
    throw new Error("Invalid geocode cache");
  }
  for (const [address, entry] of Object.entries(cache.entries)) {
    if (!normalizeText(address) || !validLocation(entry) || !["manual", "official", "gsi", "nominatim"].includes(entry.source)) {
      throw new Error(`Invalid geocode cache entry: ${address}`);
    }
  }
  return cache;
}

export function validateGeocodeOverrides(overrides) {
  if (overrides?.schemaVersion !== 1 || typeof overrides.entries !== "object" || overrides.entries === null) {
    throw new Error("Invalid geocode overrides");
  }
  for (const [address, entry] of Object.entries(overrides.entries)) {
    const hasQuery = Boolean(normalizeText(entry?.queryAddress));
    const hasLocation = validLocation(entry?.location);
    let evidence;
    try { evidence = new URL(entry?.evidenceUrl); } catch {}
    if (!normalizeText(address) || hasQuery === hasLocation || evidence?.protocol !== "https:" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(entry?.checkedAt) || !normalizeText(entry?.reason)) {
      throw new Error(`Invalid geocode override: ${address}`);
    }
  }
  return overrides;
}

function validLocation(value) {
  return Number.isFinite(value?.latitude) && value.latitude >= -90 && value.latitude <= 90 &&
    Number.isFinite(value?.longitude) && value.longitude >= -180 && value.longitude <= 180;
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function normalizeAddressName(value) {
  return normalizeText(value).replace(/^〒?\d{3}-?\d{4}\s*/, "").replaceAll(" ", "").replace(/[^都道府県市区町村郡\d]+郡(?=[^都道府県市区町村郡\d]+[町村])/g, "").replace(/大字|字/g, "").replace(/[ヶヵ]/g, "ケ");
}

function addressParts(value) {
  const address = normalizeAddressName(value);
  const prefecture = address.match(/^(北海道|東京都|京都府|大阪府|.{2,3}県)/)?.[0] ?? "";
  return { prefecture, locality: address.slice(prefecture.length).split(/\d/, 1)[0] };
}

export function addressMatches(query, ...candidates) {
  const { prefecture, locality } = addressParts(query);
  if (!prefecture || locality.length < 2) return false;
  return candidates.some((value) => {
    const candidate = normalizeAddressName(value);
    return candidate.includes(prefecture) && candidate.includes(locality);
  });
}

async function requestJson(fetcher, url, userAgent) {
  const response = await fetcher(url, { headers: { "User-Agent": userAgent } });
  if (!response.ok) throw new Error(`Geocoding failed ${response.status}: ${url.hostname}`);
  return response.json();
}

function nominatimAddress(result) {
  const fields = ["province", "state", "city", "municipality", "city_district", "ward", "suburb", "quarter", "neighbourhood", "hamlet", "village", "town", "road"];
  return fields.map((field) => result?.address?.[field] ?? "").join("");
}

function assessedCandidate(query, label, location, ...addresses) {
  return {
    label: normalizeText(label) || "(empty)",
    ...(Number.isFinite(location.latitude) ? { latitude: location.latitude } : {}),
    ...(Number.isFinite(location.longitude) ? { longitude: location.longitude } : {}),
    reason: !addressMatches(query, ...addresses) ? "address-components-mismatch" :
      !validLocation(location) ? "invalid-coordinates" : null,
  };
}

export async function geocodeRecords(records, inputCache, {
  fetcher = fetch,
  overrides = emptyGeocodeOverrides(),
  gsiDelayMs = 50,
  nominatimDelayMs = 1100,
  userAgent = process.env.GEOCODER_USER_AGENT ||
    (process.env.GITHUB_REPOSITORY ? `its-gym-map/1.0 (https://github.com/${process.env.GITHUB_REPOSITORY})` : "its-gym-map/1.0 (local catalog update)"),
} = {}) {
  const cache = structuredClone(validateGeocodeCache(inputCache));
  validateGeocodeOverrides(overrides);
  let gsiRequested = false;
  let nominatimRequested = false;
  const gyms = [];
  const unresolved = [];

  for (const record of records) {
    const key = normalizeText(record.address);
    const override = overrides.entries[key];
    if (validLocation(record.sourceLocation)) {
      cache.entries[key] = { ...record.sourceLocation, source: "official" };
    } else if (validLocation(override?.location)) {
      cache.entries[key] = { ...override.location, source: "manual" };
    }
    if (!cache.entries[key]) {
      const query = normalizeText(override?.queryAddress) || key;
      const attempts = [];
      if (gsiRequested && gsiDelayMs > 0) await wait(gsiDelayMs);
      const gsiUrl = new URL("https://msearch.gsi.go.jp/address-search/AddressSearch");
      gsiUrl.searchParams.set("q", query);
      let gsiResults = [];
      try {
        gsiResults = await requestJson(fetcher, gsiUrl, userAgent);
      } catch {
        attempts.push({ provider: "gsi", reason: "request-failed", candidates: [] });
      }
      gsiRequested = true;
      const gsiCandidates = gsiResults.map((result) => {
        const location = { latitude: Number(result?.geometry?.coordinates?.[1]), longitude: Number(result?.geometry?.coordinates?.[0]) };
        return assessedCandidate(query, result?.properties?.title, location, result?.properties?.title);
      });
      const gsi = gsiCandidates.find((candidate) => candidate.reason === null);
      if (gsi) {
        cache.entries[key] = { latitude: gsi.latitude, longitude: gsi.longitude, source: "gsi" };
      } else {
        if (!attempts.length) attempts.push({ provider: "gsi", reason: gsiCandidates.length ? "all-candidates-rejected" : "no-results", candidates: gsiCandidates });
        if (nominatimRequested && nominatimDelayMs > 0) await wait(nominatimDelayMs);
        const nominatimUrl = new URL("https://nominatim.openstreetmap.org/search");
        nominatimUrl.searchParams.set("format", "jsonv2");
        nominatimUrl.searchParams.set("limit", "5");
        nominatimUrl.searchParams.set("addressdetails", "1");
        nominatimUrl.searchParams.set("countrycodes", "jp");
        nominatimUrl.searchParams.set("q", query);
        let nominatimResults = [];
        try {
          nominatimResults = await requestJson(fetcher, nominatimUrl, userAgent);
        } catch {
          attempts.push({ provider: "nominatim", reason: "request-failed", candidates: [] });
        }
        nominatimRequested = true;
        const nominatimCandidates = nominatimResults.map((result) => {
          const location = { latitude: Number(result?.lat), longitude: Number(result?.lon) };
          return assessedCandidate(query, result?.display_name, location, result?.display_name, nominatimAddress(result));
        });
        const nominatim = nominatimCandidates.find((candidate) => candidate.reason === null);
        if (nominatim) {
          cache.entries[key] = { latitude: nominatim.latitude, longitude: nominatim.longitude, source: "nominatim" };
        } else if (!attempts.some((attempt) => attempt.provider === "nominatim")) {
          attempts.push({ provider: "nominatim", reason: nominatimCandidates.length ? "all-candidates-rejected" : "no-results", candidates: nominatimCandidates });
        }
      }
      if (!cache.entries[key]) {
        unresolved.push({
          id: record.id,
          name: record.name,
          contractRoute: record.contractRoute,
          address: record.address,
          facilitySource: record.facilitySource,
          attempts,
        });
        continue;
      }
    }
    const { sourceLocation: _, ...gym } = record;
    gyms.push({ ...gym, location: {
      longitude: cache.entries[key].longitude,
      latitude: cache.entries[key].latitude,
    } });
  }
  if (unresolved.length) {
    const error = new Error(`No verified geocoding result:\n${unresolved.map((failure) => failure.address).join("\n")}`);
    error.geocodeFailures = unresolved;
    error.geocodeCache = cache;
    throw error;
  }
  return { gyms, cache };
}
