export const CONTRACT_ROUTES = [
  "healthpia",
  "konami-direct",
  "konami-affiliate",
  "central-series",
] as const;

export type ContractRoute = (typeof CONTRACT_ROUTES)[number];

export type Fee = {
  label: string;
  yen: number;
};

export type Source = {
  url: string;
  checkedAt: string;
};

export type Gym = {
  id: string;
  name: string;
  brand: string;
  contractRoute: ContractRoute;
  address: string;
  location: { longitude: number; latitude: number };
  fees: Fee[];
  eligibilitySource: Source;
  facilitySource: Source;
};

export type Catalog = {
  schemaVersion: 1;
  generatedAt: string;
  gyms: Gym[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const isDate = (value: unknown): value is string =>
  isText(value) && /^\d{4}-\d{2}-\d{2}$/.test(value);

function isSource(value: unknown): value is Source {
  if (!isRecord(value) || !isText(value.url) || !isDate(value.checkedAt)) return false;
  try {
    return new URL(value.url).protocol === "https:";
  } catch {
    return false;
  }
}

function isGym(value: unknown): value is Gym {
  if (!isRecord(value) || !isText(value.id) || !isText(value.name) ||
    !isText(value.brand) || !isText(value.address) ||
    !CONTRACT_ROUTES.includes(value.contractRoute as ContractRoute) ||
    !isRecord(value.location) || !Array.isArray(value.fees) || value.fees.length === 0 ||
    !isSource(value.eligibilitySource) || !isSource(value.facilitySource)) return false;

  const { longitude, latitude } = value.location;
  return typeof longitude === "number" && longitude >= -180 && longitude <= 180 &&
    typeof latitude === "number" && latitude >= -90 && latitude <= 90 &&
    value.fees.every((fee) => isRecord(fee) && isText(fee.label) &&
      Number.isInteger(fee.yen) && (fee.yen as number) >= 0);
}

export function parseCatalog(value: unknown): Catalog {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isText(value.generatedAt) ||
    Number.isNaN(Date.parse(value.generatedAt)) || !Array.isArray(value.gyms) ||
    !value.gyms.every(isGym)) throw new Error("Invalid gym catalog");

  const ids = new Set(value.gyms.map((gym) => gym.id));
  if (ids.size !== value.gyms.length) throw new Error("Duplicate gym id");
  return value as Catalog;
}
