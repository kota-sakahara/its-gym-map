import type { FeatureCollection, Point } from "geojson";
import type { Gym } from "./catalog.ts";

export type GymFeatureProperties = {
  id: string;
  brand: string;
  contractRoute: Gym["contractRoute"];
  offset: [number, number];
  selected: boolean;
};

export function markerOffsets(catalog: Gym[]): Map<string, [number, number]> {
  const groups = new Map<string, Gym[]>();
  const routeOrder = ["healthpia", "konami-direct", "konami-affiliate", "central-series"];
  for (const gym of catalog) {
    const key = `${gym.location.longitude},${gym.location.latitude}`;
    groups.set(key, [...(groups.get(key) ?? []), gym]);
  }
  const offsets = new Map<string, [number, number]>();
  for (const group of groups.values()) {
    group.sort((a, b) => routeOrder.indexOf(a.contractRoute) - routeOrder.indexOf(b.contractRoute));
    group.forEach((gym, index) => {
      if (group.length === 1) return offsets.set(gym.id, [0, 0]);
      const angle = 2 * Math.PI * index / group.length;
      offsets.set(gym.id, [Math.round(Math.cos(angle) * 9), Math.round(Math.sin(angle) * 9)]);
    });
  }
  return offsets;
}

export function gymFeatureCollection(
  catalog: Gym[],
  offsets: Map<string, [number, number]>,
  selectedId?: string,
): FeatureCollection<Point, GymFeatureProperties> {
  return {
    type: "FeatureCollection",
    features: catalog.map((gym) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [gym.location.longitude, gym.location.latitude] },
      properties: {
        id: gym.id,
        brand: gym.brand,
        contractRoute: gym.contractRoute,
        offset: offsets.get(gym.id) ?? [0, 0],
        selected: gym.id === selectedId,
      },
    })),
  };
}
