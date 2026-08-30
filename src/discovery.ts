import maplibregl, { type LngLat } from "maplibre-gl";
import type { Gym } from "./catalog.ts";

export type PriceBand = "" | "0-499" | "500-999" | "1000-1499" | "1500+";
export type Filters = { query: string; brand: string; priceBand: PriceBand };
export type RankedGym = Gym & { distanceMeters: number };

const ROUTE_LABELS = {
  healthpia: "へるすぴあ",
  "konami-direct": "コナミ直営",
  "konami-affiliate": "コナミ提携",
  "central-series": "セントラル系列",
} as const;

export const routeLabel = (route: Gym["contractRoute"]): string => ROUTE_LABELS[route];

export const normalizeSearch = (value: string): string =>
  value.normalize("NFKC").toLocaleLowerCase("ja-JP").replace(/\s+/g, "");

function matchesPrice(gym: Gym, band: PriceBand): boolean {
  if (!band) return true;
  const [minimum, maximum] = band === "1500+"
    ? [1500, Infinity]
    : band.split("-").map(Number);
  return gym.fees.some(({ yen }) => yen >= minimum && yen <= maximum);
}

export function filterGyms(gyms: Gym[], filters: Filters): Gym[] {
  const query = normalizeSearch(filters.query);
  return gyms.filter((gym) => {
    const haystack = normalizeSearch([
      gym.name,
      gym.brand,
      gym.address,
      gym.contractRoute,
      routeLabel(gym.contractRoute),
    ].join(" "));
    return (!query || haystack.includes(query)) &&
      (!filters.brand || gym.brand === filters.brand) &&
      matchesPrice(gym, filters.priceBand);
  });
}

export function rankGyms(gyms: Gym[], origin: LngLat): RankedGym[] {
  return gyms.map((gym) => ({
    ...gym,
    distanceMeters: origin.distanceTo(new maplibregl.LngLat(gym.location.longitude, gym.location.latitude)),
  })).sort((a, b) => a.distanceMeters - b.distanceMeters || a.name.localeCompare(b.name, "ja"));
}

export function oldestCheckedAt(gyms: Gym[]): string {
  return gyms.flatMap(({ eligibilitySource, facilitySource }) =>
    [eligibilitySource.checkedAt, facilitySource.checkedAt]).sort()[0] ?? "";
}

export function isDataStale(checkedAt: string, now = new Date()): boolean {
  if (!checkedAt) return true;
  const checked = Date.parse(`${checkedAt}T00:00:00Z`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return !Number.isFinite(checked) || today - checked > 7 * 86_400_000;
}
