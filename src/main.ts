import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import maplibregl, { LngLat, LngLatBounds, Marker, type GeoJSONSource } from "maplibre-gl";
import { parseCatalog, type Gym } from "./catalog.ts";
import { gymFeatureCollection, markerOffsets } from "./map-data.ts";
import {
  filterGyms,
  googleSearchUrl,
  isDataStale,
  oldestCheckedAt,
  rankGyms,
  routeLabel,
  type Filters,
  type RankedGym,
} from "./discovery.ts";

const MAP_STYLE_DARK = "https://tiles.openfreemap.org/styles/dark";
const MAP_STYLE_LIGHT = "https://tiles.openfreemap.org/styles/positron";
const GYM_SOURCE = "gym-locations";
const GYM_LAYER = "gym-pins";
const GYM_GUIDE_LAYER = "gym-guides";
const TOKYO_STATION = new LngLat(139.767125, 35.681236);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const THEME_KEY = "its-gym-grid:theme";
type ThemeMode = "command" | "simple" | "kawaii";

let theme: ThemeMode = "command";
try {
  const storedTheme = localStorage.getItem(THEME_KEY);
  if (storedTheme === "simple" || storedTheme === "kawaii") theme = storedTheme;
} catch { /* Use the default theme. */ }
document.documentElement.dataset.theme = theme;
let mapStyle = theme === "kawaii" ? MAP_STYLE_LIGHT : MAP_STYLE_DARK;

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
      <span class="wordmark-mark" data-command-copy="IG" data-kawaii-copy="IG">IG</span><span data-command-copy="ITS GYM GRID" data-kawaii-copy="ITS GYM MAP">ITS GYM GRID</span>
    </a>
    <dl class="telemetry">
      <div><dt>VISIBLE</dt><dd id="visible-count">---</dd></div>
      <div><dt>ORIGIN</dt><dd id="origin-label">LOCATING</dd></div>
      <div class="telemetry-coordinate"><dt>SELECTED COORD</dt><dd id="selected-coordinate">NO FACILITY</dd></div>
      <div class="telemetry-data"><dt>DATA CHECK</dt><dd id="checked-at">----</dd></div>
      <div class="telemetry-clock"><dt>SYSTEM CLOCK / JST</dt><dd><time id="system-clock">----.--.-- // --:--:--</time></dd></div>
      <div class="telemetry-view"><dt>VIEW VECTOR</dt><dd id="view-vector">Z11.0 / B000° / P00°</dd></div>
    </dl>
    <label class="theme-switcher"><span data-command-copy="DISPLAY MODE" data-kawaii-copy="きせかえ">DISPLAY MODE</span><select id="theme-mode" aria-label="表示モード">
      <option value="command">COMMAND</option>
      <option value="simple">SIMPLE</option>
      <option value="kawaii">KAWAII ✦</option>
    </select></label>
    <span id="stale-status" class="stale-status" hidden>! DATA STALE</span>
  </header>
  <button id="current-location" class="current-location-control" type="button" aria-live="polite">◎ 現在地へ</button>
  <button id="toggle-3d" class="view-3d-control" type="button" aria-pressed="false">◇ 3D VIEW</button>
  <aside class="panel" aria-labelledby="panel-title">
    <div class="panel-heading">
      <div><span class="eyebrow" data-command-copy="FACILITY SCANNER / 01" data-kawaii-copy="GYM PICNIC">FACILITY SCANNER / 01</span><h1 id="panel-title">都度利用ジムを探す</h1></div>
      <div class="panel-actions">
        <span class="signal" aria-label="カタログ接続中">SYNC</span>
        <button id="panel-toggle" class="panel-toggle" type="button" aria-expanded="true">− 閉じる</button>
      </div>
    </div>
    <form class="filters" id="filters">
      <label class="search-field"><span data-command-copy="QUERY" data-kawaii-copy="なまえ・場所">QUERY</span><input id="query" type="search" autocomplete="off" placeholder="施設名・住所・契約経路" /></label>
      <div class="filter-grid">
        <label><span data-command-copy="BRAND" data-kawaii-copy="ジムブランド">BRAND</span><select id="brand"><option value="">すべてのブランド</option></select></label>
        <label><span data-command-copy="PRICE / VISIT" data-kawaii-copy="1回の料金">PRICE / VISIT</span><select id="price">
          <option value="">すべての料金</option>
          <option value="0-499">499円以下</option>
          <option value="500-999">500〜999円</option>
          <option value="1000-1499">1,000〜1,499円</option>
          <option value="1500+">1,500円以上</option>
        </select></label>
      </div>
    </form>
    <div class="reference-tools">
      <span data-command-copy="REFERENCE POINT" data-kawaii-copy="どこから探す？">REFERENCE POINT</span>
      <button id="center-pin" type="button">＋ 地図中央にピン</button>
      <button id="reset-pin" type="button" disabled>× ピン解除</button>
    </div>
    <p class="map-hint">地図をクリックして基準ピンを設定。ピンはドラッグできます。</p>
    <div id="result-summary" class="result-summary" aria-live="polite">カタログを読込中...</div>
    <div id="gym-list" class="gym-list" aria-label="距離順のジム一覧"></div>
  </aside>
  <details class="map-legend" aria-label="地図記号の凡例" open>
    <summary data-command-copy="MAP LEGEND / 凡例" data-kawaii-copy="地図のしるし">MAP LEGEND / 凡例</summary>
    <div class="legend-grid">
      <span><i class="legend-symbol route-healthpia"></i>へるすぴあ</span>
      <span><i class="legend-symbol route-konami-direct"></i>コナミ直営</span>
      <span><i class="legend-symbol route-konami-affiliate"></i>コナミ提携</span>
      <span><i class="legend-symbol route-central-series"></i>セントラル系列</span>
      <span><i class="legend-origin"></i>現在地 / 東京駅</span>
      <span><i class="legend-origin is-custom"></i>任意の基準ピン</span>
    </div>
    <small data-command-copy="マゼンタの施設ピンは選択中" data-kawaii-copy="ピンクのピンは選んだジム">マゼンタの施設ピンは選択中</small>
  </details>
  <section id="gym-detail" class="gym-detail" aria-live="polite" aria-labelledby="gym-detail-name" hidden>
    <header class="detail-heading">
      <span data-command-copy="SELECTED FACILITY / 詳細" data-kawaii-copy="ジムの詳細">SELECTED FACILITY / 詳細</span>
      <button id="detail-close" type="button" aria-label="施設詳細を閉じる" data-command-copy="× CLOSE" data-kawaii-copy="× とじる">× CLOSE</button>
    </header>
    <div id="detail-content"></div>
  </section>
  <button class="reticle" type="button" aria-label="地図を北向きに戻す" title="地図を北向きに戻す">
    <i class="radar-sweep" aria-hidden="true"></i><span class="compass-needle" aria-hidden="true"><b>N</b></span>
  </button>
  <footer class="site-footer">(C) <a href="https://github.com/kota-sakahara" target="_blank" rel="noreferrer">Kota Sakahara</a> 2026 <span>//</span> <button id="briefing-open" type="button" data-command-copy="BRIEFING" data-kawaii-copy="はじめに">BRIEFING</button></footer>
  <dialog id="initial-briefing" class="briefing-dialog" aria-labelledby="briefing-title" aria-describedby="briefing-intro">
    <div class="briefing-frame">
      <header class="briefing-header">
        <span>SECURE CHANNEL // FIRST ACCESS</span>
        <b>PROTOCOL 01</b>
      </header>
      <div class="briefing-content">
        <p class="briefing-kicker" data-command-copy="INITIAL BRIEFING" data-kawaii-copy="ようこそ">INITIAL BRIEFING</p>
        <h2 id="briefing-title"><b data-command-copy="ITS GYM GRID" data-kawaii-copy="ITS GYM MAP">ITS GYM GRID</b> <span data-command-copy="// SYSTEM ACCESS" data-kawaii-copy="あなたにぴったりのジム探し">// SYSTEM ACCESS</span></h2>
        <p id="briefing-intro" class="briefing-intro">このサイトは、関東ITソフトウェア健康保険組合（ITS）の補助対象ジムを探すための、非公式ナビゲーションシステムです。ITSおよび各施設運営者が提供する公式サービスではありません。</p>

        <aside class="training-message">
          <small data-command-copy="TRAINING MESSAGE" data-kawaii-copy="今日のひとこと">TRAINING MESSAGE</small>
          <strong>最高のメニューを考えるより、今日一回ジムへ行く方が強い。</strong>
          <p>近い、安い、なんとなく気になる。理由は何でもOK。<br />今日の目的地を決めて、身体を動かしに行こう。</p>
        </aside>

        <div class="briefing-grid">
          <section>
            <small data-command-copy="DATA ACCURACY // 掲載情報" data-kawaii-copy="掲載情報について">DATA ACCURACY // 掲載情報</small>
            <p>掲載施設・料金・住所は、画面に表示された最終確認日時点の公開情報です。情報の完全性・正確性・最新性は保証されません。</p>
          </section>
          <section>
            <small data-command-copy="ACCESS CONDITIONS // 利用条件" data-kawaii-copy="利用するときのこと">ACCESS CONDITIONS // 利用条件</small>
            <p>利用資格、年齢制限、事前登録、必要書類、手数料などは施設や契約経路によって異なります。本サイトは利用資格を判定しません。利用前に必ず公式サイトで最新情報をご確認ください。</p>
          </section>
          <section>
            <small data-command-copy="POSITION DATA // 位置情報" data-kawaii-copy="現在地について">POSITION DATA // 位置情報</small>
            <p>表示距離は基準地点からの直線距離であり、実際の経路や所要時間ではありません。現在地はブラウザ内での検索と距離計算に利用し、本サイトには保存しません。地図表示や外部リンクの利用時には、外部サービスとの通信が発生します。</p>
          </section>
        </div>

        <div class="briefing-final">
          <small data-command-copy="FINAL CHECK" data-kawaii-copy="だいじなおねがい">FINAL CHECK</small>
          <p>本サイトの情報だけを根拠に利用を決定せず、最終的な料金・利用可否・営業状況を公式サイトまたは施設へご確認ください。</p>
        </div>
      </div>
      <footer class="briefing-action">
        <small>このブリーフィングは初回のみ表示されます。フッターからいつでも再確認できます。</small>
        <button id="briefing-accept" type="button"><span data-command-copy="BRIEFING ACKNOWLEDGED" data-kawaii-copy="確認しました">BRIEFING ACKNOWLEDGED</span><small data-command-copy="内容を確認してシステムを起動" data-kawaii-copy="ジムを見つけにいく">内容を確認してシステムを起動</small></button>
      </footer>
    </div>
  </dialog>
`;

const required = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

const visibleCount = required<HTMLElement>("#visible-count");
const originLabel = required<HTMLElement>("#origin-label");
const selectedCoordinate = required<HTMLElement>("#selected-coordinate");
const checkedAtElement = required<HTMLElement>("#checked-at");
const systemClock = required<HTMLTimeElement>("#system-clock");
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
const briefingDialog = required<HTMLDialogElement>("#initial-briefing");
const briefingAcceptButton = required<HTMLButtonElement>("#briefing-accept");
const briefingOpenButton = required<HTMLButtonElement>("#briefing-open");
const themeSelect = required<HTMLSelectElement>("#theme-mode");

const updateThemeCopy = (): void => document.querySelectorAll<HTMLElement>("[data-command-copy]").forEach((element) => {
  element.textContent = theme === "kawaii" ? element.dataset.kawaiiCopy! : element.dataset.commandCopy!;
});

themeSelect.value = theme;
updateThemeCopy();
themeSelect.addEventListener("change", () => {
  theme = themeSelect.value as ThemeMode;
  document.documentElement.dataset.theme = theme;
  updateThemeCopy();
  update3dButton(is3d);
  const nextMapStyle = theme === "kawaii" ? MAP_STYLE_LIGHT : MAP_STYLE_DARK;
  if (mapStyle !== nextMapStyle) {
    mapStyle = nextMapStyle;
    mapStyleReady = false;
    map.setStyle(mapStyle);
  } else if (gyms.length && mapStyleReady) updateGymImages();
  if (gyms.length) render();
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* Storage may be unavailable. */ }
});

if (matchMedia("(max-width: 760px)").matches) mapLegend.open = false;

const state: State = {
  origin: TOKYO_STATION,
  referenceKind: "tokyo",
  filters: { query: "", brand: "", priceBand: "" },
  detailOpen: false,
};

let mapStyleReady = false;
const map = new maplibregl.Map({
  container: "map",
  style: mapStyle,
  center: TOKYO_STATION,
  zoom: 11,
  attributionControl: { compact: true },
});
map.on("style.load", () => {
  mapStyleReady = true;
  if (gyms.length && !map.getSource(GYM_SOURCE)) createGymLayer();
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
map.on("rotate", () => { compassNeedle.style.transform = `rotate(${-map.getBearing()}deg)`; });
map.on("move", () => {
  const bearing = (Math.round(map.getBearing()) + 360) % 360;
  viewVector.textContent = `Z${map.getZoom().toFixed(1)} / B${String(bearing).padStart(3, "0")}° / P${String(Math.round(map.getPitch())).padStart(2, "0")}°`;
});
compassButton.addEventListener("click", () => map.easeTo({ bearing: 0, duration: reduceMotion ? 0 : 500 }));
let is3d = false;
const update3dButton = (active: boolean): void => {
  view3dButton.textContent = theme === "kawaii"
    ? active ? "平面で見る" : "立体で見る"
    : active ? "□ 2D VIEW" : "◇ 3D VIEW";
};
map.on("pitch", () => {
  const active = map.getPitch() > 30;
  if (active === is3d) return;
  is3d = active;
  update3dButton(active);
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
let gymLayerEventsBound = false;

const escapeHtml = (value: string): string => value.replace(/[&<>"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
})[character]!);

const formatDistance = (meters: number): string => meters < 1000
  ? `${Math.max(1, Math.round(meters / 10) * 10)} m`
  : `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
const gymLngLat = (gym: Gym): LngLat => new LngLat(gym.location.longitude, gym.location.latitude);

const tokyoClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function updateSystemClock(): void {
  const now = new Date();
  const parts = Object.fromEntries(tokyoClock.formatToParts(now).map(({ type, value }) => [type, value]));
  systemClock.dateTime = now.toISOString();
  systemClock.textContent = `${parts.year}.${parts.month}.${parts.day} // ${parts.hour}:${parts.minute}:${parts.second} JST`;
}

updateSystemClock();
window.setInterval(updateSystemClock, 1000);

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
  const searchUrl = escapeHtml(googleSearchUrl(gym));
  detailContent.innerHTML = `
    <div class="detail-meta"><b>${escapeHtml(gym.brand)}</b><span>${escapeHtml(routeLabel(gym.contractRoute))}</span></div>
    <h2 id="gym-detail-name">${escapeHtml(gym.name)}</h2>
    <div class="detail-stats">
      <div><small>${theme === "kawaii" ? "ITS利用料金" : "ITS PRICE / VISIT"}</small><div class="detail-fees">${fees}</div></div>
      <div><small>${theme === "kawaii" ? "直線距離" : "DISTANCE / STRAIGHT"}</small><strong>${formatDistance(gym.distanceMeters)}</strong></div>
    </div>
    <p class="detail-address"><small>${theme === "kawaii" ? "住所" : "ADDRESS"}</small>${escapeHtml(gym.address)}</p>
    <div class="detail-links">
      <a class="detail-link is-google" href="${searchUrl}" target="_blank" rel="noreferrer">Google検索 ↗</a>
    </div>`;
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
  selectedCoordinate.textContent = selected
    ? `${selected.location.latitude.toFixed(5)} / ${selected.location.longitude.toFixed(5)}`
    : "NO FACILITY";
  resetPinButton.disabled = state.referenceKind !== "pin";
  resultSummary.textContent = ranked.length
    ? theme === "kawaii" ? `近い順に ${ranked.length} 件みつかりました` : `${ranked.length} FACILITIES // NEAREST FIRST`
    : theme === "kawaii" ? "条件に合うジムが見つかりませんでした" : "NO FACILITIES // 条件に一致するジムがありません";
  list.innerHTML = ranked.map((gym, index) => gymCard(gym, index)).join("");
  list.querySelectorAll<HTMLButtonElement>(".card-select").forEach((card) => {
    card.addEventListener("click", () => selectGym(card.dataset.id!, true));
  });
}

function gymCard(gym: RankedGym, index: number): string {
  const fees = gym.fees.map(({ label, yen }) =>
    `<span><small>${escapeHtml(label)}</small>¥${yen.toLocaleString("ja-JP")}</span>`).join("");
  const searchUrl = escapeHtml(googleSearchUrl(gym));
  return `<article class="gym-card${state.selectedId === gym.id ? " is-selected" : ""}" data-id="${gym.id}">
    <button class="card-select" type="button" data-id="${gym.id}">
      <span class="card-index">${String(index + 1).padStart(3, "0")}</span>
      <span class="card-body">
        <span class="card-meta"><b>${escapeHtml(gym.brand)}</b><i>${escapeHtml(routeLabel(gym.contractRoute))}</i></span>
        <strong>${escapeHtml(gym.name)}</strong>
        <span class="address">${escapeHtml(gym.address)}</span>
        <span class="fees">${fees}</span>
      </span>
      <span class="distance"><b>${formatDistance(gym.distanceMeters)}</b><small>${theme === "kawaii" ? "直線距離" : "STRAIGHT"}</small></span>
    </button>
    <div class="card-links">
      <a class="source-link" href="${searchUrl}" target="_blank" rel="noreferrer">Google検索 ↗</a>
    </div>
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
  context.shadowBlur = theme === "simple" ? 0 : theme === "kawaii" ? 6 : 17;
  context.fill();
  context.shadowBlur = 0;
  context.strokeStyle = theme === "kawaii" ? "#fff8fc" : theme === "simple" ? "#111" : "#041016";
  context.lineWidth = theme === "kawaii" ? 4 : 3;
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
  context.font = theme === "kawaii" ? "700 16px ui-rounded, sans-serif" : "700 16px ui-monospace, monospace";
  context.fillStyle = theme === "kawaii" ? "rgb(255 250 252 / .96)" : "rgb(3 11 17 / .92)";
  context.fillRect(1, 1, canvas.width - 2, 30);
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.shadowColor = color;
  context.shadowBlur = theme === "simple" ? 0 : theme === "kawaii" ? 5 : 12;
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

function updateGymImages(): void {
  const normalColor = theme === "kawaii" ? "#df8bb3" : theme === "simple" ? "#a8a8a8" : "#39f6ff";
  const selectedColor = theme === "kawaii" ? "#f04f98" : theme === "simple" ? "#f4f4f4" : "#ff3daa";
  const setImage = (id: string, image: ImageData): void => {
    if (map.hasImage(id)) map.updateImage(id, image);
    else map.addImage(id, image, { pixelRatio: 2 });
  };
  for (const route of ["healthpia", "konami-direct", "konami-affiliate", "central-series"] as const) {
    setImage(`gym-${route}`, pinImage(route, normalColor));
    setImage(`gym-${route}-selected`, pinImage(route, selectedColor));
  }
  for (const brand of new Set(gyms.map((gym) => gym.brand))) {
    setImage(`gym-guide-normal-${brand}`, guideImage(brand, normalColor));
    setImage(`gym-guide-selected-${brand}`, guideImage(brand, selectedColor));
  }
}

function createGymLayer(): void {
  offsets = markerOffsets(gyms);
  updateGymImages();
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
  updateGymSource();
  if (!gymLayerEventsBound) {
    gymLayerEventsBound = true;
    map.on("click", GYM_LAYER, ({ features }) => {
      const id = features?.[0]?.properties.id;
      if (typeof id === "string") selectGym(id);
    });
    map.on("mouseenter", GYM_LAYER, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", GYM_LAYER, () => { map.getCanvas().style.cursor = ""; });
  }
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
    bindControls();
    setReference(TOKYO_STATION, "tokyo", true);
    if (mapStyleReady && !map.getSource(GYM_SOURCE)) createGymLayer();

    const currentLocation = await locationPromise;
    if (currentLocation) {
      state.currentLocation = currentLocation;
      if (state.referenceKind === "tokyo") setReference(currentLocation, "current", true);
    }
  } catch (error) {
    signal.textContent = "ERROR";
    signal.classList.add("is-error");
    resultSummary.textContent = theme === "kawaii" ? "ジム情報を読み込めませんでした" : "CATALOG ERROR // データを読み込めませんでした";
    console.error(error);
  }
}

const BRIEFING_KEY = "its-gym-grid:briefing:v1";
let systemStarted = false;
const startSystem = (): void => {
  if (systemStarted) return;
  systemStarted = true;
  void start();
};

briefingDialog.addEventListener("cancel", (event) => event.preventDefault());
briefingOpenButton.addEventListener("click", () => briefingDialog.showModal());
briefingAcceptButton.addEventListener("click", () => {
  try { localStorage.setItem(BRIEFING_KEY, "acknowledged"); } catch { /* Storage may be unavailable. */ }
  briefingDialog.close();
  startSystem();
});

let briefingAcknowledged = false;
try { briefingAcknowledged = localStorage.getItem(BRIEFING_KEY) === "acknowledged"; } catch { /* Show briefing. */ }
if (briefingAcknowledged) startSystem();
else briefingDialog.showModal();
