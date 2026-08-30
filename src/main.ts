import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import maplibregl, { LngLat, LngLatBounds, Marker, type GeoJSONSource } from "maplibre-gl";
import { parseCatalog, type Gym } from "./catalog.ts";
import { gymFeatureCollection, markerOffsets } from "./map-data.ts";
import {
  filterGyms,
  isDataStale,
  oldestCheckedAt,
  rankGyms,
  routeLabel,
  type Filters,
  type RankedGym,
} from "./discovery.ts";

const MAP_STYLE = "https://tiles.openfreemap.org/styles/dark";
const GYM_SOURCE = "gym-locations";
const GYM_LAYER = "gym-pins";
const GYM_GUIDE_LAYER = "gym-guides";
const TOKYO_STATION = new LngLat(139.767125, 35.681236);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

type ReferenceKind = "current" | "tokyo" | "pin";
type State = {
  origin: LngLat;
  currentLocation?: LngLat;
  referenceKind: ReferenceKind;
  filters: Filters;
  selectedId?: string;
  detailOpen: boolean;
};

const app = document.querySelector<HTMLElement>("#app")!;
app.innerHTML = `
  <div id="map" aria-label="ITS補助対象ジムの地図"></div>
  <div class="map-scanner" aria-hidden="true"></div>
  <header class="status-bar" aria-label="データステータス">
    <a class="wordmark" href="./" aria-label="ITS GYM GRID ホーム">
      <span class="wordmark-mark">IG</span><span>ITS GYM GRID</span>
    </a>
    <dl class="telemetry">
      <div><dt>VISIBLE</dt><dd id="visible-count">---</dd></div>
      <div><dt>ORIGIN</dt><dd id="origin-label">LOCATING</dd></div>
      <div class="telemetry-data"><dt>DATA CHECK</dt><dd id="checked-at">----</dd></div>
      <div class="telemetry-view"><dt>VIEW VECTOR</dt><dd id="view-vector">Z11.0 / B000° / P00°</dd></div>
    </dl>
    <span id="stale-status" class="stale-status" hidden>! DATA STALE</span>
  </header>
  <button id="current-location" class="current-location-control" type="button" aria-live="polite">◎ 現在地へ</button>
  <button id="toggle-3d" class="view-3d-control" type="button" aria-pressed="false">◇ 3D VIEW</button>
  <aside class="panel" aria-labelledby="panel-title">
    <div class="panel-heading">
      <div><span class="eyebrow">FACILITY SCANNER / 01</span><h1 id="panel-title">都度利用ジムを探す</h1></div>
      <div class="panel-actions">
        <span class="signal" aria-label="カタログ接続中">SYNC</span>
        <button id="panel-toggle" class="panel-toggle" type="button" aria-expanded="true">− 閉じる</button>
      </div>
    </div>
    <form class="filters" id="filters">
      <label class="search-field"><span>QUERY</span><input id="query" type="search" autocomplete="off" placeholder="施設名・住所・契約経路" /></label>
      <div class="filter-grid">
        <label><span>BRAND</span><select id="brand"><option value="">すべてのブランド</option></select></label>
        <label><span>PRICE / VISIT</span><select id="price">
          <option value="">すべての料金</option>
          <option value="0-499">499円以下</option>
          <option value="500-999">500〜999円</option>
          <option value="1000-1499">1,000〜1,499円</option>
          <option value="1500+">1,500円以上</option>
        </select></label>
      </div>
    </form>
    <div class="reference-tools">
      <span>REFERENCE POINT</span>
      <button id="center-pin" type="button">＋ 地図中央にピン</button>
      <button id="reset-pin" type="button" disabled>× ピン解除</button>
    </div>
    <p class="map-hint">地図をクリックして基準ピンを設定。ピンはドラッグできます。</p>
    <div id="result-summary" class="result-summary" aria-live="polite">カタログを読込中...</div>
    <div id="gym-list" class="gym-list" aria-label="距離順のジム一覧"></div>
  </aside>
  <details class="map-legend" aria-label="地図記号の凡例" open>
    <summary>MAP LEGEND / 凡例</summary>
    <div class="legend-grid">
      <span><i class="legend-symbol route-healthpia"></i>へるすぴあ</span>
      <span><i class="legend-symbol route-konami-direct"></i>コナミ直営</span>
      <span><i class="legend-symbol route-konami-affiliate"></i>コナミ提携</span>
      <span><i class="legend-symbol route-central-series"></i>セントラル系列</span>
      <span><i class="legend-origin"></i>現在地 / 東京駅</span>
      <span><i class="legend-origin is-custom"></i>任意の基準ピン</span>
    </div>
    <small>マゼンタの施設ピンは選択中</small>
  </details>
  <section id="gym-detail" class="gym-detail" aria-live="polite" aria-labelledby="gym-detail-name" hidden>
    <header class="detail-heading">
      <span>SELECTED FACILITY / 詳細</span>
      <button id="detail-close" type="button" aria-label="施設詳細を閉じる">× CLOSE</button>
    </header>
    <div id="detail-content"></div>
  </section>
  <button class="reticle" type="button" aria-label="地図を北向きに戻す" title="地図を北向きに戻す">
    <i class="radar-sweep" aria-hidden="true"></i><span class="compass-needle" aria-hidden="true"><b>N</b></span>
  </button>
  <footer class="site-footer">(C) <a href="https://github.com/kota-sakahara" target="_blank" rel="noreferrer">Kota Sakahara</a> 2026</footer>
`;

const required = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

const visibleCount = required<HTMLElement>("#visible-count");
const originLabel = required<HTMLElement>("#origin-label");
const checkedAtElement = required<HTMLElement>("#checked-at");
const viewVector = required<HTMLElement>("#view-vector");
const staleStatus = required<HTMLElement>("#stale-status");
const signal = required<HTMLElement>(".signal");
const panel = required<HTMLElement>(".panel");
const panelToggleButton = required<HTMLButtonElement>("#panel-toggle");
const mapLegend = required<HTMLDetailsElement>(".map-legend");
const gymDetail = required<HTMLElement>("#gym-detail");
const detailContent = required<HTMLElement>("#detail-content");
const detailCloseButton = required<HTMLButtonElement>("#detail-close");
const list = required<HTMLElement>("#gym-list");
const resultSummary = required<HTMLElement>("#result-summary");
const queryInput = required<HTMLInputElement>("#query");
const brandSelect = required<HTMLSelectElement>("#brand");
const priceSelect = required<HTMLSelectElement>("#price");
const currentLocationButton = required<HTMLButtonElement>("#current-location");
const view3dButton = required<HTMLButtonElement>("#toggle-3d");
const centerPinButton = required<HTMLButtonElement>("#center-pin");
const resetPinButton = required<HTMLButtonElement>("#reset-pin");
const compassButton = required<HTMLButtonElement>(".reticle");
const compassNeedle = required<HTMLElement>(".compass-needle");

if (matchMedia("(max-width: 760px)").matches) mapLegend.open = false;

const state: State = {
  origin: TOKYO_STATION,
  referenceKind: "tokyo",
  filters: { query: "", brand: "", priceBand: "" },
  detailOpen: false,
};

const map = new maplibregl.Map({
  container: "map",
  style: MAP_STYLE,
  center: TOKYO_STATION,
  zoom: 11,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
map.on("rotate", () => { compassNeedle.style.transform = `rotate(${-map.getBearing()}deg)`; });
map.on("move", () => {
  const bearing = (Math.round(map.getBearing()) + 360) % 360;
  viewVector.textContent = `Z${map.getZoom().toFixed(1)} / B${String(bearing).padStart(3, "0")}° / P${String(Math.round(map.getPitch())).padStart(2, "0")}°`;
});
compassButton.addEventListener("click", () => map.easeTo({ bearing: 0, duration: reduceMotion ? 0 : 500 }));
let is3d = false;
map.on("pitch", () => {
  const active = map.getPitch() > 30;
  if (active === is3d) return;
  is3d = active;
  view3dButton.textContent = active ? "□ 2D VIEW" : "◇ 3D VIEW";
  view3dButton.setAttribute("aria-pressed", String(active));
  if (map.getLayer(GYM_GUIDE_LAYER)) {
    map.setLayoutProperty(GYM_GUIDE_LAYER, "visibility", active ? "visible" : "none");
  }
});
view3dButton.addEventListener("click", () => {
  const active = map.getPitch() > 30;
  map.easeTo({
    pitch: active ? 0 : 55,
    bearing: active ? 0 : -20,
    duration: reduceMotion ? 0 : 900,
  });
});
const locationControl = document.createElement("div");
locationControl.className = "maplibregl-ctrl maplibregl-ctrl-group";
locationControl.append(currentLocationButton, view3dButton);
map.addControl({ onAdd: () => locationControl, onRemove: () => locationControl.remove() }, "bottom-right");

let gyms: Gym[] = [];
let visibleGyms: RankedGym[] = [];
let offsets = new Map<string, [number, number]>();
let referenceMarker: Marker | undefined;
let currentLocationMarker: Marker | undefined;

const escapeHtml = (value: string): string => value.replace(/[&<>"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
})[character]!);

const formatDistance = (meters: number): string => meters < 1000
  ? `${Math.max(1, Math.round(meters / 10) * 10)} m`
  : `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
const gymLngLat = (gym: Gym): LngLat => new LngLat(gym.location.longitude, gym.location.latitude);

function referenceLabel(kind: ReferenceKind): string {
  return kind === "current" ? "CURRENT LOCATION" : kind === "pin" ? "CUSTOM PIN" : "TOKYO STATION";
}

function setPanelCollapsed(collapsed: boolean): void {
  panel.classList.toggle("is-collapsed", collapsed);
  app.classList.toggle("panel-collapsed", collapsed);
  panelToggleButton.setAttribute("aria-expanded", String(!collapsed));
  panelToggleButton.textContent = collapsed ? "+ 一覧を開く" : "− 閉じる";
}

function renderGymDetail(gym: RankedGym): void {
  const fees = gym.fees.map(({ label, yen }) =>
    `<span><small>${escapeHtml(label)}</small><b>¥${yen.toLocaleString("ja-JP")}</b></span>`).join("");
  detailContent.innerHTML = `
    <div class="detail-meta"><b>${escapeHtml(gym.brand)}</b><span>${escapeHtml(routeLabel(gym.contractRoute))}</span></div>
    <h2 id="gym-detail-name">${escapeHtml(gym.name)}</h2>
    <div class="detail-stats">
      <div><small>ITS PRICE / VISIT</small><div class="detail-fees">${fees}</div></div>
      <div><small>DISTANCE / STRAIGHT</small><strong>${formatDistance(gym.distanceMeters)}</strong></div>
    </div>
    <p class="detail-address"><small>ADDRESS</small>${escapeHtml(gym.address)}</p>
    <a class="detail-link" href="${escapeHtml(gym.facilitySource.url)}" target="_blank" rel="noreferrer">施設公式情報を開く ↗</a>`;
  gymDetail.hidden = false;
}

function selectGym(id: string, moveMap = false): void {
  const gym = visibleGyms.find((entry) => entry.id === id);
  if (!gym) return;
  state.selectedId = id;
  state.detailOpen = true;
  document.querySelectorAll<HTMLElement>(".gym-card").forEach((element) =>
    element.classList.toggle("is-selected", element.dataset.id === id));
  updateGymSource();
  renderGymDetail(gym);
  const card = [...document.querySelectorAll<HTMLElement>(".gym-card")]
    .find((element) => element.dataset.id === id);
  card?.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
  if (innerWidth <= 760) setPanelCollapsed(true);
  if (moveMap) {
    map.easeTo({ center: gymLngLat(gym), zoom: Math.max(map.getZoom(), 13), duration: reduceMotion ? 0 : 600 });
  }
}

function render(): void {
  const ranked = rankGyms(filterGyms(gyms, state.filters), state.origin);
  const selected = ranked.find((gym) => gym.id === state.selectedId);
  if (state.selectedId && !selected) {
    state.selectedId = undefined;
    state.detailOpen = false;
    gymDetail.hidden = true;
  }
  visibleGyms = ranked;
  updateGymSource();
  if (selected && state.detailOpen) renderGymDetail(selected);

  visibleCount.textContent = `${ranked.length} / ${gyms.length}`;
  originLabel.textContent = referenceLabel(state.referenceKind);
  resetPinButton.disabled = state.referenceKind !== "pin";
  resultSummary.textContent = ranked.length
    ? `${ranked.length} FACILITIES // NEAREST FIRST`
    : "NO FACILITIES // 条件に一致するジムがありません";
  list.innerHTML = ranked.map((gym, index) => gymCard(gym, index)).join("");
  list.querySelectorAll<HTMLButtonElement>(".card-select").forEach((card) => {
    card.addEventListener("click", () => selectGym(card.dataset.id!, true));
  });
}

function gymCard(gym: RankedGym, index: number): string {
  const fees = gym.fees.map(({ label, yen }) =>
    `<span><small>${escapeHtml(label)}</small>¥${yen.toLocaleString("ja-JP")}</span>`).join("");
  return `<article class="gym-card${state.selectedId === gym.id ? " is-selected" : ""}" data-id="${gym.id}">
    <button class="card-select" type="button" data-id="${gym.id}">
      <span class="card-index">${String(index + 1).padStart(3, "0")}</span>
      <span class="card-body">
        <span class="card-meta"><b>${escapeHtml(gym.brand)}</b><i>${escapeHtml(routeLabel(gym.contractRoute))}</i></span>
        <strong>${escapeHtml(gym.name)}</strong>
        <span class="address">${escapeHtml(gym.address)}</span>
        <span class="fees">${fees}</span>
      </span>
      <span class="distance"><b>${formatDistance(gym.distanceMeters)}</b><small>STRAIGHT</small></span>
    </button>
    <a class="source-link" href="${escapeHtml(gym.facilitySource.url)}" target="_blank" rel="noreferrer">公式情報を開く ↗</a>
  </article>`;
}

function setReference(origin: LngLat, kind: ReferenceKind, fit = false): void {
  state.origin = origin;
  state.referenceKind = kind;
  referenceMarker?.remove();
  referenceMarker = undefined;
  const element = document.createElement("div");
  element.className = `reference-marker reference-${kind}`;
  element.title = referenceLabel(kind);
  const marker = new Marker({ element, draggable: kind === "pin", anchor: "center" })
    .setLngLat(origin).addTo(map);
  if (kind === "current") {
    currentLocationMarker?.remove();
    currentLocationMarker = marker;
  } else {
    referenceMarker = marker;
    if (kind === "pin") marker.on("dragend", () => setReference(marker.getLngLat(), "pin"));
  }
  render();
  if (fit) fitOriginAndNearest();
}

function fitOriginAndNearest(): void {
  const nearest = rankGyms(gyms, state.origin)[0];
  if (!nearest) return;
  const mobile = innerWidth <= 760;
  map.fitBounds(new LngLatBounds(state.origin, state.origin).extend(gymLngLat(nearest)), {
    padding: mobile
      ? { top: 80, right: 40, bottom: Math.min(innerHeight * .58 + 20, 500), left: 40 }
      : { top: 90, right: 60, bottom: 60, left: 460 },
    maxZoom: 14,
    duration: reduceMotion ? 0 : 900,
  });
}

function pinImage(route: Gym["contractRoute"], color: string): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable");
  context.translate(32, 32);
  context.beginPath();
  if (route === "healthpia") context.arc(0, 0, 13, 0, Math.PI * 2);
  else if (route === "konami-direct") {
    context.moveTo(0, -15); context.lineTo(15, 0); context.lineTo(0, 15); context.lineTo(-15, 0);
  } else if (route === "konami-affiliate") {
    context.moveTo(0, -15); context.lineTo(15, 13); context.lineTo(-15, 13);
  } else context.rect(-13, -13, 26, 26);
  context.closePath();
  context.fillStyle = color;
  context.shadowColor = color;
  context.shadowBlur = 17;
  context.fill();
  context.shadowBlur = 0;
  context.strokeStyle = "#041016";
  context.lineWidth = 3;
  context.stroke();
  return context.getImageData(0, 0, 64, 64);
}

function guideImage(brand: string, color: string): ImageData {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable");
  context.font = "700 16px ui-monospace, monospace";
  canvas.width = Math.max(144, Math.ceil(context.measureText(brand).width + 28));
  canvas.height = 144;
  context.font = "700 16px ui-monospace, monospace";
  context.fillStyle = "rgb(3 11 17 / .92)";
  context.fillRect(1, 1, canvas.width - 2, 30);
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.shadowColor = color;
  context.shadowBlur = 12;
  context.strokeRect(1, 1, canvas.width - 2, 30);
  context.fillStyle = color;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(brand, canvas.width / 2, 16);
  const gradient = context.createLinearGradient(0, 31, 0, canvas.height);
  gradient.addColorStop(0, `${color}55`);
  gradient.addColorStop(1, color);
  context.strokeStyle = gradient;
  context.beginPath();
  context.moveTo(canvas.width / 2, 31);
  context.lineTo(canvas.width / 2, canvas.height);
  context.stroke();
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function createGymLayer(): void {
  offsets = markerOffsets(gyms);
  for (const route of ["healthpia", "konami-direct", "konami-affiliate", "central-series"] as const) {
    map.addImage(`gym-${route}`, pinImage(route, "#39f6ff"), { pixelRatio: 2 });
    map.addImage(`gym-${route}-selected`, pinImage(route, "#ff3daa"), { pixelRatio: 2 });
  }
  for (const brand of new Set(gyms.map((gym) => gym.brand))) {
    map.addImage(`gym-guide-normal-${brand}`, guideImage(brand, "#39f6ff"), { pixelRatio: 2 });
    map.addImage(`gym-guide-selected-${brand}`, guideImage(brand, "#ff3daa"), { pixelRatio: 2 });
  }
  map.addSource(GYM_SOURCE, { type: "geojson", data: gymFeatureCollection([], offsets) });
  map.addLayer({
    id: GYM_GUIDE_LAYER,
    type: "symbol",
    source: GYM_SOURCE,
    layout: {
      "visibility": is3d ? "visible" : "none",
      "icon-image": ["concat", "gym-guide-", ["case", ["get", "selected"], "selected", "normal"], "-", ["get", "brand"]],
      "icon-anchor": "bottom",
      "icon-offset": { type: "identity", property: "offset", default: [0, 0] },
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "icon-pitch-alignment": "viewport",
      "icon-rotation-alignment": "viewport",
    },
  });
  map.addLayer({
    id: GYM_LAYER,
    type: "symbol",
    source: GYM_SOURCE,
    layout: {
      "icon-image": ["concat", "gym-", ["get", "contractRoute"], ["case", ["get", "selected"], "-selected", ""]],
      "icon-anchor": "center",
      "icon-offset": { type: "identity", property: "offset", default: [0, 0] },
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "icon-pitch-alignment": "viewport",
      "icon-rotation-alignment": "viewport",
    },
  });
  map.on("click", GYM_LAYER, ({ features }) => {
    const id = features?.[0]?.properties.id;
    if (typeof id === "string") selectGym(id);
  });
  map.on("mouseenter", GYM_LAYER, () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", GYM_LAYER, () => { map.getCanvas().style.cursor = ""; });
}

function updateGymSource(): void {
  const source = map.getSource(GYM_SOURCE) as GeoJSONSource | undefined;
  source?.setData(gymFeatureCollection(visibleGyms, offsets, state.selectedId));
}

function geolocate(): Promise<LngLat | undefined> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(undefined);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve(new LngLat(coords.longitude, coords.latitude)),
      () => resolve(undefined),
      { enableHighAccuracy: false, timeout: 7000, maximumAge: 300_000 },
    );
  });
}

async function moveToCurrentLocation(): Promise<void> {
  const label = "◎ 現在地へ";
  currentLocationButton.disabled = true;
  currentLocationButton.textContent = "… 取得中";
  const location = await geolocate();
  currentLocationButton.disabled = false;
  if (location) {
    state.currentLocation = location;
    currentLocationButton.textContent = label;
    return setReference(location, "current", true);
  }
  currentLocationButton.textContent = window.isSecureContext
    ? "! 位置情報の許可を確認"
    : "! HTTPS / localhost が必要";
  window.setTimeout(() => { currentLocationButton.textContent = label; }, 3000);
}

function bindControls(): void {
  queryInput.addEventListener("input", () => { state.filters.query = queryInput.value; render(); });
  brandSelect.addEventListener("change", () => { state.filters.brand = brandSelect.value; render(); });
  priceSelect.addEventListener("change", () => {
    state.filters.priceBand = priceSelect.value as Filters["priceBand"];
    render();
  });
  currentLocationButton.addEventListener("click", () => void moveToCurrentLocation());
  panelToggleButton.addEventListener("click", () => setPanelCollapsed(!panel.classList.contains("is-collapsed")));
  detailCloseButton.addEventListener("click", () => {
    state.detailOpen = false;
    gymDetail.hidden = true;
  });
  centerPinButton.addEventListener("click", () => setReference(map.getCenter(), "pin"));
  resetPinButton.addEventListener("click", () => setReference(
    state.currentLocation ?? TOKYO_STATION,
    state.currentLocation ? "current" : "tokyo",
    true,
  ));
  map.on("click", ({ lngLat, originalEvent, point }) => {
    if ((originalEvent.target as HTMLElement).closest(".maplibregl-control-container")) return;
    if (map.queryRenderedFeatures(point, { layers: [GYM_LAYER] }).length) return;
    setReference(lngLat, "pin");
  });
}

async function start(): Promise<void> {
  const locationPromise = geolocate();
  try {
    const response = await fetch(new URL("gyms.json", document.baseURI));
    if (!response.ok) throw new Error(`Catalog request failed: ${response.status}`);
    const catalog = parseCatalog(await response.json());
    gyms = catalog.gyms;
    const checkedAt = oldestCheckedAt(gyms);
    checkedAtElement.textContent = checkedAt;
    staleStatus.hidden = !isDataStale(checkedAt);
    signal.textContent = "ONLINE";
    signal.setAttribute("aria-label", "カタログ接続済み");
    for (const brand of [...new Set(gyms.map(({ brand }) => brand))].sort((a, b) => a.localeCompare(b, "ja"))) {
      brandSelect.add(new Option(brand, brand));
    }
    if (!map.isStyleLoaded()) await new Promise<void>((resolve) => map.once("load", () => resolve()));
    createGymLayer();
    bindControls();
    state.currentLocation = await locationPromise;
    setReference(state.currentLocation ?? TOKYO_STATION, state.currentLocation ? "current" : "tokyo", true);
  } catch (error) {
    signal.textContent = "ERROR";
    signal.classList.add("is-error");
    resultSummary.textContent = "CATALOG ERROR // データを読み込めませんでした";
    console.error(error);
  }
}

void start();
