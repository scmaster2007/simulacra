'use strict';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const CALTRANS_URL =
  'https://hub.arcgis.com/api/download/v1/items/450df5bed93c4558a7264b7ef64187e6/geojson?redirect=true&layers=0';
const CITYIQ_URL = 'data/sd-cityiq.geojson';
const WEB_MERCATOR_M_PER_PX = 156543.03392804097;
const ARC_SEGMENTS = 36;
const MIN_CAMERA_ZOOM = 14;
const MIN_COVERAGE_ZOOM = MIN_CAMERA_ZOOM;
const FETCH_DEBOUNCE_MS = 600;
const COVERAGE_FADE_MIDPOINT = 0.58;
const COVERAGE_FADE_SHOULDER = 0.86;
const COVERAGE_PAD_PX = 24;
/** Match L.circleMarker radius + stroke so coverage meets the dot. */
const CAMERA_MARKER_RADIUS_PX = 4;
const CAMERA_MARKER_STROKE_PX = 1;
const CAMERA_MARKER_ANCHOR_PX = CAMERA_MARKER_RADIUS_PX + CAMERA_MARKER_STROKE_PX;
const VIEW_3D_MAX_CAMERAS = 1400;
const VIEW_3D_MAX_BUILDINGS = 900;
const MIN_BUILDING_ZOOM = 14;
const BUILDING_FETCH_DEBOUNCE_MS = 800;

let showCoverage = true;
let currentView = '2d';

// Estimated horizontal field of view (degrees) and useful view distance (meters).
// Used for directional cones (OSM with bearing) or circular coverage (no bearing / forceCircle).
const TYPE_DEFAULTS = {
  dome:    { hfov: 360, rangeM: 15 },
  fixed:   { hfov: 70,  rangeM: 30 },
  panning: { hfov: 360, rangeM: 50 },
  alpr:    { hfov: 30,  rangeM: 40 },
  traffic: { hfov: 90,  rangeM: 85 },
  other:   { hfov: 90,  rangeM: 20 },
  unknown: { hfov: 90,  rangeM: 20 },
};

function normalizeType(raw) {
  if (!raw) return 'unknown';
  const v = String(raw).toLowerCase();
  if (v === 'dome') return 'dome';
  if (v === 'fixed') return 'fixed';
  if (v === 'panning' || v === 'ptz') return 'panning';
  if (v === 'alpr' || v === 'anpr') return 'alpr';
  if (v === 'other') return 'other';
  return 'unknown';
}

function parseBearing(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? ((n % 360) + 360) % 360 : null;
}

const DIR_TO_BEARING = {
  north: 0, northeast: 45, east: 90, southeast: 135,
  south: 180, southwest: 225, west: 270, northwest: 315,
};
function cardinalToBearing(s) {
  if (!s) return null;
  return DIR_TO_BEARING[String(s).toLowerCase().trim()] ?? null;
}

function parseHexColor(hex) {
  let value = String(hex || '').trim();
  if (value[0] === '#') value = value.slice(1);
  if (value.length === 3) {
    value = value.split('').map((ch) => ch + ch).join('');
  }
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;
  const n = parseInt(value, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgba(rgb, alpha) {
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`;
}

function coverageGeometry(c, src) {
  const typeDef = TYPE_DEFAULTS[c.type] || TYPE_DEFAULTS.unknown;
  const cov = src.coverage || {};
  const rangeM = cov.rangeByType?.[c.type] ?? cov.unknownBearingRangeM ?? typeDef.rangeM;
  const forceCircle = Boolean(cov.forceCircle);
  const hasDirection =
    !forceCircle && c.bearing != null && Number.isFinite(c.bearing) && typeDef.hfov < 360;
  return { typeDef, hasDirection, rangeM, forceCircle };
}

function coverageLabel(c, src) {
  const { typeDef, hasDirection, rangeM, forceCircle } = coverageGeometry(c, src);
  if (forceCircle) {
    return `est. view radius: ~${rangeM} m <span class="muted">(${escapeHtml(c.type)} lens, omnidirectional)</span>`;
  }
  if (hasDirection) {
    return `est. range: ~${rangeM} m, ~${typeDef.hfov}° arc <span class="muted">(from OSM bearing)</span>`;
  }
  return `est. range: ~${rangeM} m`;
}

function metersPerPixel(lat, zoom) {
  const latitudeScale = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  return (WEB_MERCATOR_M_PER_PX * latitudeScale) / (2 ** zoom);
}

function metersToPixels(lat, meters, zoom) {
  return meters / metersPerPixel(lat, zoom);
}

/** Pixel radius from live map projection (stays aligned during zoom animation). */
function metersToPixelsOnMap(mapInstance, lat, lng, meters) {
  if (!Number.isFinite(meters) || meters <= 0) return 0;
  const anchor = mapInstance.latLngToContainerPoint([lat, lng]);
  const dLng = meters / (111_320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  const edge = mapInstance.latLngToContainerPoint([lat, lng + dLng]);
  return Math.hypot(edge.x - anchor.x, edge.y - anchor.y);
}

function bearingToCanvasRad(deg) {
  return ((deg - 90) * Math.PI) / 180;
}

function cameraLocalMeters(c, origin) {
  const latScale = Math.cos((origin.lat * Math.PI) / 180);
  return {
    x: (c.lng - origin.lng) * 111_320 * latScale,
    z: -(c.lat - origin.lat) * 110_540,
  };
}

function bearingOffsetMeters(bearing, distance) {
  const rad = (bearing * Math.PI) / 180;
  return {
    x: Math.sin(rad) * distance,
    z: -Math.cos(rad) * distance,
  };
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

async function overpassQuery(query, signal) {
  let lastErr = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const res = await fetch(endpoint, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      signal,
    });
    if (res.status === 429) {
      lastErr = new Error('overpass 429');
      continue;
    }
    if (!res.ok) {
      lastErr = new Error('overpass ' + res.status);
      continue;
    }
    return res.json();
  }
  throw lastErr || new Error('overpass failed');
}

/** Scale 3D meshes so poles/cones stay visible at the current map zoom. */
function scene3dVisualScale(lat, zoom) {
  const mpp = metersPerPixel(lat, zoom);
  const targetScreenM = mpp * 16;
  return Math.max(1, Math.min(80, targetScreenM / 10));
}

async function fetchOsm(bbox, signal) {
  const { s, w, n, e } = bbox;
  const query =
    `[out:json][timeout:25];` +
    `(node["man_made"="surveillance"](${s},${w},${n},${e});` +
    ` node["surveillance"="camera"](${s},${w},${n},${e}););` +
    `out body;`;
  const data = await overpassQuery(query, signal);
  const out = [];
  for (const el of data.elements || []) {
    if (el.type !== 'node') continue;
    const tags = el.tags || {};
    const surv = tags['surveillance:type'] || tags.surveillance;
    if (surv && !['camera', 'webcam', 'ALPR', 'alpr'].includes(surv)) continue;
    const type = surv === 'ALPR' || surv === 'alpr' ? 'alpr' : normalizeType(tags['camera:type']);
    out.push({
      source: 'osm',
      id: String(el.id),
      lng: el.lon,
      lat: el.lat,
      type,
      bearing: parseBearing(tags['camera:direction']),
      operator: tags.operator || null,
      externalUrl: `https://www.openstreetmap.org/node/${el.id}`,
    });
  }
  return out;
}

function parseBuildingHeightM(tags) {
  if (!tags) return 10;
  const rawH = tags.height;
  if (rawH != null && rawH !== '') {
    const m = parseFloat(String(rawH).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(m) && m > 0) return Math.min(m, 120);
  }
  const levels = parseFloat(tags['building:levels'] ?? tags.levels ?? '');
  if (Number.isFinite(levels) && levels > 0) return Math.min(levels * 3.2, 120);
  const type = String(tags.building || 'yes').toLowerCase();
  if (type === 'garage' || type === 'shed' || type === 'roof' || type === 'bunker') return 4;
  if (type === 'house' || type === 'residential' || type === 'detached') return 8;
  if (type === 'apartments' || type === 'commercial' || type === 'retail' || type === 'office') return 14;
  if (type === 'industrial' || type === 'warehouse' || type === 'factory') return 16;
  if (type === 'skyscraper' || type === 'tower') return 36;
  return 10;
}

function footprintsFromOsmElements(elements) {
  const nodes = new Map();
  const footprints = [];
  for (const el of elements || []) {
    if (el.type === 'node') nodes.set(el.id, { lng: el.lon, lat: el.lat });
  }
  for (const el of elements || []) {
    if (el.type !== 'way' || !el.tags?.building || !el.nodes?.length) continue;
    const ring = [];
    let ok = true;
    for (const nid of el.nodes) {
      const n = nodes.get(nid);
      if (!n) {
        ok = false;
        break;
      }
      ring.push(n);
    }
    if (!ok || ring.length < 3) continue;
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first.lng === last.lng && first.lat === last.lat) ring.pop();
    if (ring.length < 3) continue;
    footprints.push({ ring, heightM: parseBuildingHeightM(el.tags) });
  }
  return footprints;
}

async function fetchOsmBuildings(bbox, signal) {
  const { s, w, n, e } = bbox;
  const query =
    `[out:json][timeout:45];` +
    `(way["building"](${s},${w},${n},${e}););` +
    `out body;>;out skel qt;`;
  const data = await overpassQuery(query, signal);
  return footprintsFromOsmElements(data.elements);
}

async function fetchCaltrans(_bbox, signal) {
  const res = await fetch(CALTRANS_URL, { signal });
  if (!res.ok) throw new Error('caltrans ' + res.status);
  const data = await res.json();
  const out = [];
  for (const f of data.features || []) {
    if (!f.geometry || f.geometry.type !== 'Point') continue;
    const [lng, lat] = f.geometry.coordinates;
    const p = f.properties || {};
    if (p.inService === 'False') continue;
    out.push({
      source: 'caltrans',
      id: 'ct-' + p.OBJECTID,
      lng, lat,
      type: 'traffic',
      bearing: null,
      label: p.locationName,
      route: p.route,
      county: p.county,
      imageUrl: p.currentImageURL || null,
      externalUrl: 'https://cwwp2.dot.ca.gov/vm/iframemap.htm',
    });
  }
  return out;
}

async function fetchCityIq(_bbox, signal) {
  const res = await fetch(CITYIQ_URL, { signal });
  if (!res.ok) throw new Error('cityiq ' + res.status);
  const data = await res.json();
  const out = [];
  for (const f of data.features || []) {
    if (!f.geometry || f.geometry.type !== 'Point') continue;
    const [lng, lat] = f.geometry.coordinates;
    const p = f.properties || {};
    out.push({
      source: 'cityiq',
      id: 'ciq-' + p.assetUid,
      lng, lat,
      type: 'fixed',
      bearing: null,
      externalUrl: 'https://www.techpolicy.press/san-diego-street-smarts-and-surveillance/',
    });
  }
  return out;
}

async function fetchUserCameras() {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    return [];
  }

  const res = await fetch(
    `${config.supabaseUrl}/rest/v1/user_cameras_public?select=id,lng,lat,bearing,type,brand,model,ai_confidence,ai_reason,created_at&order=created_at.desc`,
    {
      headers: getRequestHeaders(),
    },
  );

  if (!res.ok) {
    throw new Error(`user cameras ${res.status}`);
  }

  const rows = await res.json();
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    source: 'user',
    id: String(row.id),
    lng: Number(row.lng),
    lat: Number(row.lat),
    type: normalizeType(row.type),
    bearing: parseBearing(String(row.bearing ?? '')),
    brand: row.brand || null,
    model: row.model || null,
    aiConfidence: row.ai_confidence == null ? null : Number(row.ai_confidence),
    aiReason: row.ai_reason || null,
    externalUrl: null,
  }));
}

// Per-source `coverage` config controls how coverage renders.
// - fill: peak opacity nearest the camera; fades to transparent by range.
// - forceCircle: radial “field of view” disc (no directional cone).
// - rangeByType: override radius (m) per camera type for this source.
// - unknownBearingRangeM: fallback radius when type has no entry in rangeByType.
const SOURCES = {
  osm: {
    label: 'OpenStreetMap',
    scope: 'worldwide',
    color: '#ff4d4d',
    enabled: true,
    bboxFetch: true,
    minZoom: MIN_CAMERA_ZOOM,
    drawCones: true,
    coverage: { fill: 0.18 },
    fetch: fetchOsm,
  },
  caltrans: {
    label: 'Caltrans CCTV',
    scope: 'California highways',
    color: '#ffd24d',
    enabled: true,
    bboxFetch: false,
    minZoom: MIN_CAMERA_ZOOM,
    drawCones: true,
    // Inventory “direction” is view axis, not reliable for map cones — use type radius only.
    coverage: { fill: 0.12, forceCircle: true, rangeByType: { traffic: 85 } },
    fetch: fetchCaltrans,
  },
  cityiq: {
    label: 'San Diego CityIQ',
    scope: 'San Diego only',
    color: '#4dffb8',
    enabled: true,
    bboxFetch: false,
    minZoom: MIN_CAMERA_ZOOM,
    drawCones: true,
    coverage: { fill: 0.05, forceCircle: true, rangeByType: { fixed: 15 } },
    fetch: fetchCityIq,
  },
  user: {
    label: 'Community submissions',
    scope: 'Supabase',
    color: '#8b5cf6',
    enabled: true,
    bboxFetch: false,
    minZoom: MIN_CAMERA_ZOOM,
    drawCones: true,
    coverage: { fill: 0.22 },
    fetch: fetchUserCameras,
  },
};

for (const src of Object.values(SOURCES)) {
  src.colorRgb = parseHexColor(src.color) || { r: 255, g: 255, b: 255 };
}

const map = L.map('map', {
  zoomControl: true,
  zoomSnap: 0.5,
  zoomDelta: 0.5,
  wheelPxPerZoomLevel: 90,
  zoomAnimation: true,
  fadeAnimation: true,
  markerZoomAnimation: true,
}).setView([37.7749, -122.4194], 14);

map.createPane('coveragePane');
const coveragePane = map.getPane('coveragePane');
coveragePane.style.zIndex = 350;
coveragePane.style.pointerEvents = 'none';

map.createPane('scene3dPane');
map.getPane('scene3dPane').style.zIndex = '680';
map.getPane('scene3dPane').style.pointerEvents = 'none';

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/">OSM</a> contributors &copy; <a href="https://carto.com/">CARTO</a>',
}).addTo(map);

const canvasRenderer = L.canvas({ padding: 0.5 });

const FadedCoverageLayer = L.Layer.extend({
  options: { pane: 'coveragePane' },

  initialize(sourceId, options) {
    L.Util.setOptions(this, options);
    this.sourceId = sourceId;
    this._redrawFrame = 0;
  },

  onAdd(mapInstance) {
    this._map = mapInstance;
    this._canvas = L.DomUtil.create('canvas', 'leaflet-layer leaflet-coverage-layer');
    this._ctx = this._canvas.getContext('2d');
    this.getPane().appendChild(this._canvas);
    this._scheduleReset = this._scheduleReset.bind(this);
    mapInstance.on('move zoom zoomanim resize viewreset', this._scheduleReset, this);
    this._resetNow();
  },

  onRemove(mapInstance) {
    mapInstance.off('move zoom zoomanim resize viewreset', this._scheduleReset, this);
    if (this._redrawFrame) {
      cancelAnimationFrame(this._redrawFrame);
      this._redrawFrame = 0;
    }
    if (this._canvas) L.DomUtil.remove(this._canvas);
    this._map = null;
    this._canvas = null;
    this._ctx = null;
  },

  redraw() {
    this._scheduleReset();
    return this;
  },

  _scheduleReset() {
    if (!this._map || !this._canvas || !this._ctx) return;
    if (this._redrawFrame) return;
    this._redrawFrame = requestAnimationFrame(() => {
      this._redrawFrame = 0;
      this._resetNow();
    });
  },

  _resetNow() {
    if (!this._map || !this._canvas || !this._ctx) return;
    const size = this._map.getSize();
    const topLeft = this._map.containerPointToLayerPoint([0, 0]);
    const scale = window.devicePixelRatio || 1;

    L.DomUtil.setPosition(this._canvas, topLeft);
    this._canvas.width = Math.max(1, Math.round(size.x * scale));
    this._canvas.height = Math.max(1, Math.round(size.y * scale));
    this._canvas.style.width = `${size.x}px`;
    this._canvas.style.height = `${size.y}px`;
    this._ctx.setTransform(scale, 0, 0, scale, 0, 0);
    this._draw();
  },

  _draw() {
    const mapInstance = this._map;
    const ctx = this._ctx;
    if (!mapInstance || !ctx) return;

    const size = mapInstance.getSize();
    ctx.clearRect(0, 0, size.x, size.y);

    if (mapInstance.getZoom() < MIN_COVERAGE_ZOOM) return;

    const src = SOURCES[this.sourceId];
    const st = state[this.sourceId];
    if (!src?.enabled || !src.drawCones || !st?.cameras?.length) return;

    const cov = src.coverage || {};
    const peakOpacity = cov.fill ?? 0.18;

    for (const c of st.cameras) {
      const { typeDef, hasDirection, rangeM } = coverageGeometry(c, src);
      this._drawCameraCoverage(ctx, mapInstance, size, c, typeDef, rangeM, src.colorRgb, peakOpacity, hasDirection);
    }
  },

  _drawCameraCoverage(ctx, mapInstance, size, c, typeDef, rangeM, rgb, peakOpacity, hasDirection) {
    if (
      !Number.isFinite(c.lng) ||
      !Number.isFinite(c.lat) ||
      !Number.isFinite(rangeM) ||
      rangeM <= 0
    ) {
      return;
    }

    const center = mapInstance.latLngToContainerPoint([c.lat, c.lng]);
    const radiusPx = metersToPixelsOnMap(mapInstance, c.lat, c.lng, rangeM);
    if (!Number.isFinite(radiusPx) || radiusPx <= 0.5) return;
    if (
      center.x + radiusPx < -COVERAGE_PAD_PX ||
      center.y + radiusPx < -COVERAGE_PAD_PX ||
      center.x - radiusPx > size.x + COVERAGE_PAD_PX ||
      center.y - radiusPx > size.y + COVERAGE_PAD_PX
    ) {
      return;
    }

    const gradient = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, radiusPx);
    gradient.addColorStop(0, rgba(rgb, peakOpacity));
    const anchorStop = Math.min(0.4, CAMERA_MARKER_ANCHOR_PX / radiusPx);
    if (anchorStop > 0) gradient.addColorStop(anchorStop, rgba(rgb, peakOpacity));
    gradient.addColorStop(COVERAGE_FADE_MIDPOINT, rgba(rgb, peakOpacity * 0.45));
    gradient.addColorStop(COVERAGE_FADE_SHOULDER, rgba(rgb, peakOpacity * 0.08));
    gradient.addColorStop(1, rgba(rgb, 0));

    ctx.beginPath();
    ctx.fillStyle = gradient;

    if (hasDirection) {
      const start = bearingToCanvasRad(c.bearing - typeDef.hfov / 2);
      const end = bearingToCanvasRad(c.bearing + typeDef.hfov / 2);
      ctx.moveTo(center.x, center.y);
      ctx.arc(center.x, center.y, radiusPx, start, end);
      ctx.closePath();
    } else {
      ctx.arc(center.x, center.y, radiusPx, 0, Math.PI * 2);
    }

    ctx.fill();
  },
});

class CameraScene3D {
  constructor(mapInstance) {
    this.map = mapInstance;
    this._canvas = null;
    this.active = false;
    this.ready = false;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.root = null;
    this.THREE = null;
    this.animationFrame = 0;
    this.updateFrame = 0;
    this.lastItemCount = 0;
    this.glError = null;
    this.azimuth = -0.78;
    this.elevation = 0.56;
    this.distance = 900;
    this.userOrbit = false;
    this.drag = null;
    this.buildings = null;
    this.buildingsBboxKey = '';
    this.buildingsLoading = false;
    this.buildingsError = null;
    this.buildingsInflight = null;
    this._mapEl = null;

    this._onMapPointerDown = this._onMapPointerDown.bind(this);
    this._onMapPointerMove = this._onMapPointerMove.bind(this);
    this._onMapPointerUp = this._onMapPointerUp.bind(this);
    this._onMapWheel = this._onMapWheel.bind(this);
    this._animate = this._animate.bind(this);
  }

  attachCanvas(canvas) {
    this._canvas = canvas;
  }

  detachCanvas() {
    this._canvas = null;
  }

  activate() {
    if (this.active) return;
    this.active = true;
    this.glError = null;
    try {
      this.ensure();
    } catch (err) {
      this.active = false;
      this.glError = err.message || String(err);
      throw err;
    }
    this.userOrbit = false;
    this.elevation = 0.78;
    this.azimuth = -0.78;
    this._bindMapInteraction();
    this.scheduleUpdate();
    this.scheduleBuildingLoad();
    this._start();
    updateStatus();
  }

  deactivate() {
    if (!this.active) return;
    this.active = false;
    this.userOrbit = false;
    this._unbindMapInteraction();
    this._abortBuildingLoad();
    this._stop();
    this._disposeGL();
    updateStatus();
  }

  syncLayout(cssWidth, cssHeight) {
    if (!this._canvas || !this.ready || !this.renderer || !this.camera) return;
    const w = Math.max(1, cssWidth);
    const h = Math.max(1, cssHeight);
    const scale = window.devicePixelRatio || 1;
    const pw = Math.max(1, Math.round(w * scale));
    const ph = Math.max(1, Math.round(h * scale));
    if (this._canvas.width !== pw || this._canvas.height !== ph) {
      this._canvas.width = pw;
      this._canvas.height = ph;
      this.renderer.setSize(pw, ph, false);
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.scheduleUpdate();
  }

  ensure() {
    if (this.ready) return;
    const THREE = window.THREE;
    if (!THREE?.Scene) {
      throw new Error('Three.js did not load (check network / ad blocker)');
    }
    if (!this._canvas) {
      throw new Error('3D canvas not mounted');
    }

    this.THREE = THREE;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 12000);
    this.root = new THREE.Group();
    this.scene.add(this.root);

    const ambient = new THREE.HemisphereLight(0xbfd7ff, 0x1a2430, 0.95);
    this.scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(300, 500, 200);
    this.scene.add(key);

    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this._canvas,
        alpha: true,
        antialias: true,
        premultipliedAlpha: false,
      });
    } catch (err) {
      throw new Error('WebGL unavailable: ' + (err.message || err));
    }
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x000000, 0);
    if (THREE.SRGBColorSpace) this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.ready = true;
  }

  _disposeGL() {
    this._clearRoot();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
    this.scene = null;
    this.camera = null;
    this.root = null;
    this.ready = false;
    this.lastItemCount = 0;
  }

  scheduleBuildingLoad() {
    if (!this.active || !this.ready) return;
    if (this.buildingLoadFrame) cancelAnimationFrame(this.buildingLoadFrame);
    this.buildingLoadFrame = requestAnimationFrame(() => {
      this.buildingLoadFrame = 0;
      this.loadBuildings();
    });
  }

  _abortBuildingLoad() {
    if (this.buildingsInflight) {
      this.buildingsInflight.abort();
      this.buildingsInflight = null;
    }
    this.buildingsLoading = false;
  }

  async loadBuildings() {
    if (!this.active) return;
    if (this.map.getZoom() < MIN_BUILDING_ZOOM) {
      this.buildings = [];
      this.buildingsBboxKey = '';
      this.buildingsError = null;
      this.scheduleUpdate();
      return;
    }

    const bounds = this.map.getBounds().pad(0.12);
    const bbox = {
      s: bounds.getSouth(),
      w: bounds.getWest(),
      n: bounds.getNorth(),
      e: bounds.getEast(),
    };
    const key = [bbox.s, bbox.w, bbox.n, bbox.e].map((x) => x.toFixed(4)).join(',');
    if (key === this.buildingsBboxKey && this.buildings) return;

    if (this.buildingsInflight) this.buildingsInflight.abort();
    const ctrl = new AbortController();
    this.buildingsInflight = ctrl;
    this.buildingsLoading = true;
    this.buildingsError = null;

    try {
      const footprints = await fetchOsmBuildings(bbox, ctrl.signal);
      if (ctrl.signal.aborted || !this.active) return;
      this.buildings = footprints;
      this.buildingsBboxKey = key;
      this.scheduleUpdate();
    } catch (err) {
      if (err.name === 'AbortError') return;
      this.buildingsError = err.message;
      console.error('[buildings]', err);
    } finally {
      if (this.buildingsInflight === ctrl) this.buildingsInflight = null;
      this.buildingsLoading = false;
    }
  }

  scheduleUpdate() {
    if (!this.active || !this.ready || this.updateFrame) return;
    this.updateFrame = requestAnimationFrame(() => {
      this.updateFrame = 0;
      this.rebuild();
    });
  }

  rebuild() {
    if (!this.ready) return;
    this._clearRoot();

    const origin = this.map.getCenter();
    const bounds = this.map.getBounds().pad(0.18);
    const widthM = Math.abs(bounds.getEast() - bounds.getWest()) * 111_320 * Math.cos((origin.lat * Math.PI) / 180);
    const depthM = Math.abs(bounds.getNorth() - bounds.getSouth()) * 110_540;
    const gridSize = Math.max(240, Math.min(5000, Math.max(widthM, depthM) * 1.15));
    const itemsBySource = this._visibleItemsBySource(bounds, origin);

    if (this.buildings?.length && this.map.getZoom() >= MIN_BUILDING_ZOOM) {
      this._addBuildings(this.buildings, origin);
    }

    if (!this.userOrbit) {
      this.distance = Math.max(320, Math.min(2200, gridSize * 0.58));
    }
    this._updateCamera();

    let itemCount = 0;
    for (const [id, items] of itemsBySource.entries()) {
      if (!items.length) continue;
      itemCount += items.length;
      const src = SOURCES[id];
      this._addCameraInstances(items, src);
      if (showCoverage && this.map.getZoom() >= MIN_COVERAGE_ZOOM) {
        this._addCoverageVolume(items, src);
      }
    }

    const visualScale = scene3dVisualScale(origin.lat, this.map.getZoom());
    this.root.scale.setScalar(visualScale);
    this.lastItemCount = itemCount;
    updateStatus();
  }

  _visibleItemsBySource(bounds, origin) {
    const out = new Map();
    let total = 0;
    for (const [id, src] of Object.entries(SOURCES)) {
      const st = state[id];
      const items = [];
      if (!src.enabled || !st?.cameras?.length) {
        out.set(id, items);
        continue;
      }
      for (const c of st.cameras) {
        if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) continue;
        if (!bounds.contains([c.lat, c.lng])) continue;
        const { typeDef, hasDirection, rangeM } = coverageGeometry(c, src);
        const pos = cameraLocalMeters(c, origin);
        items.push({ c, typeDef, hasDirection, rangeM, x: pos.x, z: pos.z });
      }
      total += items.length;
      out.set(id, items);
    }

    if (total <= VIEW_3D_MAX_CAMERAS) return out;

    const stride = Math.ceil(total / VIEW_3D_MAX_CAMERAS);
    const sampled = new Map();
    for (const [id, items] of out.entries()) {
      sampled.set(id, items.filter((_, index) => index % stride === 0));
    }
    return sampled;
  }

  _addBuildings(footprints, origin) {
    const THREE = this.THREE;
    let list = footprints;
    if (list.length > VIEW_3D_MAX_BUILDINGS) {
      const stride = Math.ceil(list.length / VIEW_3D_MAX_BUILDINGS);
      list = list.filter((_, index) => index % stride === 0);
    }

    const material = new THREE.MeshBasicMaterial({
      color: 0x5a7a90,
      transparent: true,
      opacity: 0.82,
    });
    const group = new THREE.Group();

    for (const fp of list) {
      const shape = new THREE.Shape();
      fp.ring.forEach((pt, index) => {
        const local = cameraLocalMeters(pt, origin);
        if (index === 0) shape.moveTo(local.x, local.z);
        else shape.lineTo(local.x, local.z);
      });
      const geom = new THREE.ExtrudeGeometry(shape, {
        depth: fp.heightM,
        bevelEnabled: false,
      });
      geom.rotateX(-Math.PI / 2);
      group.add(new THREE.Mesh(geom, material));
    }

    if (group.children.length) this.root.add(group);
  }

  _addCameraInstances(items, src) {
    const THREE = this.THREE;
    const color = this._colorInt(src.colorRgb);
    const mastGeometry = new THREE.CylinderGeometry(1.05, 1.35, 9, 6);
    const headGeometry = new THREE.SphereGeometry(2.9, 12, 8);
    const mastMaterial = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92 });
    const headMaterial = new THREE.MeshBasicMaterial({ color });
    const mast = new THREE.InstancedMesh(mastGeometry, mastMaterial, items.length);
    const heads = new THREE.InstancedMesh(headGeometry, headMaterial, items.length);
    const matrix = new THREE.Matrix4();

    items.forEach((item, index) => {
      matrix.makeTranslation(item.x, 4.5, item.z);
      mast.setMatrixAt(index, matrix);
      matrix.makeTranslation(item.x, 10.4, item.z);
      heads.setMatrixAt(index, matrix);
    });

    mast.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    this.root.add(mast, heads);
  }

  _addCoverageVolume(items, src) {
    const THREE = this.THREE;
    const positions = [];
    const colors = [];
    const linePositions = [];
    const rgb = src.colorRgb;
    const inner = [rgb.r / 255, rgb.g / 255, rgb.b / 255];
    const mid = inner.map((v) => v * 0.58);
    const outer = inner.map((v) => v * 0.16);
    const apexY = 11.5;
    const groundY = 0.15;

    const pushVertex = (x, y, z, color) => {
      positions.push(x, y, z);
      colors.push(color[0], color[1], color[2]);
    };
    const pushTriangle = (a, b, c, ca, cb, cc) => {
      pushVertex(a.x, a.y, a.z, ca);
      pushVertex(b.x, b.y, b.z, cb);
      pushVertex(c.x, c.y, c.z, cc);
    };
    const pushLine = (a, b) => {
      linePositions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    };

    for (const item of items) {
      const apex = { x: item.x, y: apexY, z: item.z };
      const center = { x: item.x, y: groundY, z: item.z };
      const span = item.hasDirection ? item.typeDef.hfov : 360;
      const segments = Math.max(12, Math.ceil(span / 8));
      const start = item.hasDirection ? item.c.bearing - item.typeDef.hfov / 2 : 0;
      let prev = null;

      for (let i = 0; i <= segments; i++) {
        const bearing = start + (i / segments) * span;
        const offset = bearingOffsetMeters(bearing, item.rangeM);
        const point = { x: item.x + offset.x, y: groundY, z: item.z + offset.z };
        if (prev) {
          pushTriangle(apex, prev, point, inner, outer, outer);
          pushTriangle(center, point, prev, mid, outer, outer);
          pushLine(prev, point);
        } else if (item.hasDirection) {
          pushLine(apex, point);
        }
        prev = point;
      }

      if (item.hasDirection && prev) {
        const firstOffset = bearingOffsetMeters(start, item.rangeM);
        pushLine(apex, { x: item.x + firstOffset.x, y: groundY, z: item.z + firstOffset.z });
        pushLine(apex, prev);
      }
    }

    if (!positions.length) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: Math.min(0.55, (src.coverage?.fill ?? 0.18) * 2.8),
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.root.add(new THREE.Mesh(geometry, material));

    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    const line = new THREE.LineSegments(
      lineGeometry,
      new THREE.LineBasicMaterial({
        color: this._colorInt(rgb),
        transparent: true,
        opacity: 0.52,
        depthWrite: false,
      }),
    );
    this.root.add(line);
  }

  _colorInt(rgb) {
    return (rgb.r << 16) + (rgb.g << 8) + rgb.b;
  }

  _clearRoot() {
    if (!this.root) return;
    while (this.root.children.length) {
      const child = this.root.children.pop();
      this._disposeObject(child);
    }
  }

  _disposeObject(obj) {
    obj.traverse?.((node) => {
      node.geometry?.dispose?.();
      if (Array.isArray(node.material)) {
        node.material.forEach((mat) => mat.dispose?.());
      } else {
        node.material?.dispose?.();
      }
    });
  }

  _bindMapInteraction() {
    this._mapEl = this.map.getContainer();
    this._mapEl.addEventListener('pointerdown', this._onMapPointerDown);
    this._mapEl.addEventListener('wheel', this._onMapWheel, { passive: false });
  }

  _unbindMapInteraction() {
    if (!this._mapEl) return;
    this._mapEl.removeEventListener('pointerdown', this._onMapPointerDown);
    this._mapEl.removeEventListener('wheel', this._onMapWheel);
    this._onMapPointerUp();
    this._mapEl = null;
  }

  _onMapPointerDown(ev) {
    if (!this.active || ev.button !== 0 || !ev.shiftKey) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.userOrbit = true;
    this.drag = { x: ev.clientX, y: ev.clientY, azimuth: this.azimuth, elevation: this.elevation };
    window.addEventListener('pointermove', this._onMapPointerMove);
    window.addEventListener('pointerup', this._onMapPointerUp);
    window.addEventListener('pointercancel', this._onMapPointerUp);
  }

  _onMapPointerMove(ev) {
    if (!this.drag) return;
    const dx = ev.clientX - this.drag.x;
    const dy = ev.clientY - this.drag.y;
    this.azimuth = this.drag.azimuth - dx * 0.006;
    this.elevation = Math.max(0.28, Math.min(1.22, this.drag.elevation + dy * 0.004));
    this._updateCamera();
  }

  _onMapPointerUp() {
    if (!this.drag) return;
    this.drag = null;
    window.removeEventListener('pointermove', this._onMapPointerMove);
    window.removeEventListener('pointerup', this._onMapPointerUp);
    window.removeEventListener('pointercancel', this._onMapPointerUp);
  }

  _onMapWheel(ev) {
    if (!this.active || !ev.shiftKey) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.userOrbit = true;
    this.distance = Math.max(180, Math.min(4200, this.distance * (1 + ev.deltaY * 0.001)));
    this._updateCamera();
  }

  _updateCamera() {
    if (!this.camera) return;
    const horizontal = this.distance * Math.cos(this.elevation);
    const y = this.distance * Math.sin(this.elevation);
    this.camera.position.set(
      Math.sin(this.azimuth) * horizontal,
      y,
      Math.cos(this.azimuth) * horizontal,
    );
    this.camera.lookAt(0, 0, 0);
    this.dirty = true;
  }

  _start() {
    if (!this.animationFrame) this.animationFrame = requestAnimationFrame(this._animate);
  }

  _stop() {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = 0;
    }
  }

  _animate() {
    if (!this.active || !this.renderer || !this.scene || !this.camera) {
      this.animationFrame = 0;
      return;
    }
    this.renderer.render(this.scene, this.camera);
    this.animationFrame = requestAnimationFrame(this._animate);
  }
}

const Scene3DLeafletLayer = L.Layer.extend({
  options: { pane: 'scene3dPane' },

  initialize(sceneInstance) {
    this._scene = sceneInstance;
  },

  onAdd(mapInstance) {
    this._map = mapInstance;
    this._canvas = L.DomUtil.create('canvas', 'leaflet-layer leaflet-scene3d-canvas');
    this._canvas.style.pointerEvents = 'none';
    this.getPane().appendChild(this._canvas);
    this._scene.attachCanvas(this._canvas);
    mapInstance.on('move zoom zoomend resize viewreset', this._sync, this);
    this._sync();
    try {
      this._scene.activate();
      this._sync();
    } catch (err) {
      console.error('[3d]', err);
      if (mapInstance.hasLayer(this)) mapInstance.removeLayer(this);
      if (currentView === '3d') setViewMode('2d');
    }
  },

  onRemove(mapInstance) {
    mapInstance.off('move zoom zoomend resize viewreset', this._sync, this);
    this._scene.deactivate();
    this._scene.detachCanvas();
    if (this._canvas) L.DomUtil.remove(this._canvas);
    this._map = null;
    this._canvas = null;
  },

  _sync() {
    if (!this._map || !this._canvas) return;
    const size = this._map.getSize();
    const topLeft = this._map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this._canvas, topLeft);
    this._canvas.style.width = `${size.x}px`;
    this._canvas.style.height = `${size.y}px`;
    this._scene.syncLayout(size.x, size.y);
  },
});

const state = {};
for (const id of Object.keys(SOURCES)) {
  state[id] = {
    layer: L.layerGroup(),         // dots — always on when source is enabled
    coverageLayer: new FadedCoverageLayer(id), // distance-faded cones/circles
    cameras: null,
    loading: false,
    error: null,
    inflight: null,
    lastBboxKey: '',
  };
  if (SOURCES[id].enabled) state[id].layer.addTo(map);
}

const scene3d = new CameraScene3D(map);
const scene3dLayer = new Scene3DLeafletLayer(scene3d);

function applyCoverageVisibility() {
  const shouldShow = showCoverage && map.getZoom() >= MIN_COVERAGE_ZOOM && currentView !== '3d';
  for (const [id, src] of Object.entries(SOURCES)) {
    const cov = state[id].coverageLayer;
    if (src.enabled && src.drawCones && shouldShow) {
      if (!map.hasLayer(cov)) cov.addTo(map);
    } else {
      if (map.hasLayer(cov)) map.removeLayer(cov);
    }
  }
}

function applyView3dLayers() {
  const is3d = currentView === '3d';
  for (const [id, src] of Object.entries(SOURCES)) {
    const st = state[id];
    if (!src.enabled) continue;
    if (is3d) {
      if (map.hasLayer(st.coverageLayer)) map.removeLayer(st.coverageLayer);
    } else if (!map.hasLayer(st.layer)) {
      st.layer.addTo(map);
    }
  }
  if (is3d) {
    scene3d.scheduleUpdate();
  } else {
    applyCoverageVisibility();
  }
}

const statusEl = document.getElementById('status');

function updateStatus() {
  const parts = [];
  const belowMinZoom = map.getZoom() < MIN_CAMERA_ZOOM;
  if (belowMinZoom) {
    parts.push(`<span class="muted">Zoom in to z ≥ ${MIN_CAMERA_ZOOM} to load cameras</span>`);
  }
  for (const [id, src] of Object.entries(SOURCES)) {
    if (!src.enabled) continue;
    const st = state[id];
    const minZoom = src.minZoom ?? MIN_CAMERA_ZOOM;
    let line;
    if (belowMinZoom || map.getZoom() < minZoom) {
      line = `${src.label}: zoom in (z ≥ ${minZoom})`;
    } else if (st.loading) line = `${src.label}: loading…`;
    else if (st.error) line = `${src.label}: ${st.error}`;
    else if (st.cameras == null) line = `${src.label}: idle`;
    else line = `${src.label}: ${st.cameras.length.toLocaleString()}`;
    parts.push(line);
  }
  if (currentView === '3d') {
    if (scene3d.glError) {
      parts.push(`3D: ${scene3d.glError}`);
    } else if (!scene3d.ready) {
      parts.push('3D: starting…');
    } else if (scene3d.lastItemCount === 0) {
      parts.push('3D: zoom in — no cameras in this view');
    } else {
      parts.push(`3D: ${scene3d.lastItemCount.toLocaleString()} cameras rendered`);
    }
  }
  statusEl.innerHTML = parts.map(escapeHtml).join('<br>');
}

function popupHtml(c, src) {
  const cov = coverageGeometry(c, src);
  const lines = [
    `<b>${escapeHtml(c.type)}</b> &middot; <span class="muted">${escapeHtml(src.label)}</span>`,
    c.brand ? `brand: ${escapeHtml(c.brand)}` : null,
    c.model ? `model: ${escapeHtml(c.model)}` : null,
    c.route ? `route: ${escapeHtml(c.route)}` : null,
    c.county ? `county: ${escapeHtml(c.county)}` : null,
    c.operator ? `operator: ${escapeHtml(c.operator)}` : null,
    c.aiConfidence != null ? `AI confidence: ${(c.aiConfidence * 100).toFixed(0)}%` : null,
    c.aiReason ? `AI reason: ${escapeHtml(c.aiReason)}` : null,
    cov.forceCircle
      ? null
      : c.bearing == null
        ? '<span class="muted">bearing: unknown</span>'
        : `bearing: ${c.bearing.toFixed(0)}°`,
    coverageLabel(c, src),
    c.imageUrl
      ? `<a href="${escapeHtml(c.imageUrl)}" target="_blank" rel="noopener"><img class="popup-snapshot" src="${escapeHtml(c.imageUrl)}" alt="Caltrans still frame" loading="lazy" /></a>`
      : null,
    c.externalUrl
      ? `<a href="${escapeHtml(c.externalUrl)}" target="_blank" rel="noopener">source ↗</a>`
      : null,
    c.source === 'user'
      ? `<span class="muted">📷 photo not retained — discarded after AI classification</span>`
      : null,
    c.source === 'user'
      ? `<button type="button" class="report-btn" data-camera-id="${escapeHtml(c.id)}">Report this camera</button>`
      : null,
  ].filter(Boolean);
  return `<div class="camera-popup">${lines.join('<br>')}</div>`;
}

function camerasVisibleForSource(src) {
  return map.getZoom() >= (src.minZoom ?? MIN_CAMERA_ZOOM);
}

function renderSource(id) {
  const src = SOURCES[id];
  const st = state[id];
  st.layer.clearLayers();
  if (!st.cameras || !camerasVisibleForSource(src)) {
    st.coverageLayer.redraw();
    scene3d.scheduleUpdate();
    return;
  }

  for (const c of st.cameras) {
    L.circleMarker([c.lat, c.lng], {
      renderer: canvasRenderer,
      radius: CAMERA_MARKER_RADIUS_PX,
      color: '#fff',
      weight: CAMERA_MARKER_STROKE_PX,
      fillColor: src.color,
      fillOpacity: 0.95,
    })
      .bindPopup(popupHtml(c, src))
      .addTo(st.layer);
  }

  st.coverageLayer.redraw();
  applyCoverageVisibility();
}

async function loadSource(id) {
  const src = SOURCES[id];
  const st = state[id];
  if (!src.enabled) return;

  if (id === 'user' && (!config.supabaseUrl || !config.supabaseAnonKey)) {
    st.cameras = [];
    st.error = 'configure Supabase';
    renderSource(id);
    updateStatus();
    return;
  }

  const minZoom = src.minZoom ?? MIN_CAMERA_ZOOM;
  if (map.getZoom() < minZoom) {
    if (src.bboxFetch) {
      st.cameras = [];
      st.lastBboxKey = '';
    }
    st.error = null;
    renderSource(id);
    updateStatus();
    return;
  }

  const bounds = map.getBounds();
  const bbox = {
    s: bounds.getSouth(), w: bounds.getWest(),
    n: bounds.getNorth(), e: bounds.getEast(),
  };

  if (src.bboxFetch) {
    const key = [bbox.s, bbox.w, bbox.n, bbox.e].map((x) => x.toFixed(4)).join(',');
    if (key === st.lastBboxKey && st.cameras) return;
    st.lastBboxKey = key;
  } else if (st.cameras) {
    renderSource(id);
    updateStatus();
    return;
  }

  if (st.inflight) st.inflight.abort();
  const ctrl = new AbortController();
  st.inflight = ctrl;
  st.loading = true;
  st.error = null;
  updateStatus();

  try {
    const cameras = await src.fetch(bbox, ctrl.signal);
    st.cameras = cameras;
    renderSource(id);
  } catch (err) {
    if (err.name === 'AbortError') return;
    st.error = err.message;
    console.error(`[${id}]`, err);
  } finally {
    if (st.inflight === ctrl) st.inflight = null;
    st.loading = false;
    updateStatus();
  }
}

function loadAllEnabled() {
  for (const id of Object.keys(SOURCES)) {
    if (SOURCES[id].enabled) loadSource(id);
  }
}

const debouncedRefresh = debounce(loadAllEnabled, FETCH_DEBOUNCE_MS);
const debouncedBuildingLoad = debounce(() => scene3d.scheduleBuildingLoad(), BUILDING_FETCH_DEBOUNCE_MS);
map.on('moveend', debouncedRefresh);
map.on('move', () => {
  if (currentView === '3d') scene3d.scheduleUpdate();
});
map.on('moveend', () => scene3d.scheduleUpdate());
map.on('resize', () => {
  if (scene3d.active && map.hasLayer(scene3dLayer) && scene3dLayer._sync) scene3dLayer._sync();
});
map.on('moveend', () => {
  if (currentView === '3d') debouncedBuildingLoad();
});
map.on('zoomend', () => {
  applyCoverageVisibility();
  if (currentView === '3d') scene3d.scheduleBuildingLoad();
});

function renderToggles() {
  const togglesEl = document.getElementById('toggles');
  togglesEl.innerHTML = '';
  for (const [id, src] of Object.entries(SOURCES)) {
    const wrap = document.createElement('label');
    wrap.className = 'toggle';
    wrap.innerHTML =
      `<input type="checkbox" data-source="${id}" ${src.enabled ? 'checked' : ''}>` +
      `<span class="sw" style="background:${src.color}"></span>` +
      `<span class="t-label">${escapeHtml(src.label)}</span>` +
      `<span class="t-scope">${escapeHtml(src.scope)}</span>`;
    togglesEl.appendChild(wrap);
  }
  togglesEl.addEventListener('change', (ev) => {
    const cb = ev.target;
    if (!(cb instanceof HTMLInputElement)) return;
    const id = cb.dataset.source;
    if (!id || !SOURCES[id]) return;
    SOURCES[id].enabled = cb.checked;
    if (cb.checked) {
      if (currentView !== '3d') state[id].layer.addTo(map);
      loadSource(id);
    } else {
      map.removeLayer(state[id].layer);
      map.removeLayer(state[id].coverageLayer);
    }
    applyView3dLayers();
    updateStatus();
  });
}

renderToggles();
updateStatus();

function setViewMode(view) {
  currentView = view;
  document.querySelectorAll('.view-toggle button').forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });

  const hint = document.getElementById('view3dHint');
  if (hint) hint.hidden = view !== '3d';

  if (view === '3d' && map.getZoom() < MIN_CAMERA_ZOOM) {
    map.setZoom(MIN_CAMERA_ZOOM);
  }

  if (view === '3d') {
    document.body.classList.add('view-3d');
    if (!map.hasLayer(scene3dLayer)) scene3dLayer.addTo(map);
  } else {
    document.body.classList.remove('view-3d');
    if (map.hasLayer(scene3dLayer)) map.removeLayer(scene3dLayer);
  }

  applyView3dLayers();
  requestAnimationFrame(() => map.invalidateSize());
}

const viewToggleEl = document.querySelector('.view-toggle');
if (viewToggleEl) {
  viewToggleEl.addEventListener('click', (ev) => {
    if (!(ev.target instanceof Element)) return;
    const button = ev.target.closest('button[data-view]');
    if (!button) return;
    setViewMode(button.dataset.view);
  });
}

document.getElementById('coverageToggle').addEventListener('change', (ev) => {
  showCoverage = ev.target.checked;
  applyCoverageVisibility();
  if (currentView === '3d') scene3d.scheduleUpdate();
});

const config = {
  supabaseUrl: String(window.SIMULACRA_CONFIG?.supabaseUrl || '').replace(/\/$/, ''),
  supabaseAnonKey: String(window.SIMULACRA_CONFIG?.supabaseAnonKey || ''),
  submitCameraFunction: String(window.SIMULACRA_CONFIG?.submitCameraFunction || 'submit-camera'),
  storageBucket: String(window.SIMULACRA_CONFIG?.storageBucket || 'camera-photos'),
};

const submissionUi = {
  photoInput: document.getElementById('photoInput'),
  photoPreview: document.getElementById('photoPreview'),
  useLocationBtn: document.getElementById('useLocationBtn'),
  submitBtn: document.getElementById('submitBtn'),
  submitStatus: document.getElementById('submitStatus'),
  selectedLat: document.getElementById('selectedLat'),
  selectedLng: document.getElementById('selectedLng'),
  selectedLocationText: document.getElementById('selectedLocationText'),
  bearingSlider: document.getElementById('bearingSlider'),
  bearingValue: document.getElementById('bearingValue'),
  bearingOmni: document.getElementById('bearingOmni'),
};

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function compassLabel(deg) {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}
function getSubmissionBearing() {
  if (submissionUi.bearingOmni.checked) return null;
  const v = Number(submissionUi.bearingSlider.value);
  return Number.isFinite(v) ? v : null;
}
function updateBearingDisplay() {
  if (submissionUi.bearingOmni.checked) {
    submissionUi.bearingValue.textContent = '—';
    submissionUi.bearingSlider.disabled = true;
  } else {
    submissionUi.bearingSlider.disabled = false;
    const v = Number(submissionUi.bearingSlider.value);
    submissionUi.bearingValue.textContent = `${v}° ${compassLabel(v)}`;
  }
}

const submissionState = {
  marker: null,
  selectedLat: null,
  selectedLng: null,
  photoFile: null,
  previewUrl: null,
  enabled: Boolean(config.supabaseUrl && config.supabaseAnonKey),
};

function setSubmissionStatus(message, tone = 'info') {
  submissionUi.submitStatus.textContent = message;
  submissionUi.submitStatus.style.color = tone === 'error' ? '#ff9b9b' : '#ffd166';
}

function setSubmissionEnabled(enabled) {
  submissionUi.photoInput.disabled = !enabled;
  submissionUi.useLocationBtn.disabled = !enabled;
  submissionUi.submitBtn.disabled = !enabled;
  submissionUi.bearingOmni.disabled = !enabled;
  // bearing slider follows omni state, but also force-off when whole panel disabled
  if (!enabled) {
    submissionUi.bearingSlider.disabled = true;
    setSubmissionStatus('Configure your Supabase URL and anon key to enable submissions.', 'error');
  } else {
    updateBearingDisplay();
  }
}

function clearPreview() {
  if (submissionState.previewUrl) {
    URL.revokeObjectURL(submissionState.previewUrl);
  }
  submissionState.previewUrl = null;
  submissionUi.photoPreview.hidden = true;
  submissionUi.photoPreview.removeAttribute('src');
  submissionUi.photoInput.value = '';
  submissionState.photoFile = null;
}

function showSelectedLocation(lat, lng) {
  submissionState.selectedLat = lat;
  submissionState.selectedLng = lng;
  submissionUi.selectedLat.value = String(lat);
  submissionUi.selectedLng.value = String(lng);
  submissionUi.selectedLocationText.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

  if (submissionState.marker) {
    submissionState.marker.setLatLng([lat, lng]);
  } else {
    submissionState.marker = L.circleMarker([lat, lng], {
      radius: 8,
      color: '#ffffff',
      weight: 2,
      fillColor: '#8b5cf6',
      fillOpacity: 0.95,
    }).addTo(map);
    submissionState.marker.bindPopup('Selected camera location');
  }

  map.flyTo([lat, lng], Math.max(map.getZoom(), 16), { duration: 0.35 });
}

function clearSelectedLocation() {
  submissionState.selectedLat = null;
  submissionState.selectedLng = null;
  submissionUi.selectedLat.value = '';
  submissionUi.selectedLng.value = '';
  submissionUi.selectedLocationText.textContent = 'No location selected';
  if (submissionState.marker) {
    map.removeLayer(submissionState.marker);
    submissionState.marker = null;
  }
}

function getRequestHeaders() {
  return {
    'Content-Type': 'application/json',
    apikey: config.supabaseAnonKey,
    Authorization: `Bearer ${config.supabaseAnonKey}`,
  };
}

// Privacy-preserving image prep: re-encode the user's file through a <canvas>
// to strip EXIF (GPS, device model, timestamp, photographer name) and shrink
// it. Returns { base64, mimeType } ready to send inline to the Edge Function —
// the raw file never leaves the browser, and nothing is stored server-side.
const MAX_IMAGE_DIM = 1600;
const JPEG_QUALITY = 0.85;

async function processImageForUpload(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('could not read photo file'));
    reader.readAsDataURL(file);
  });

  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('could not decode photo'));
    el.src = dataUrl;
  });

  let { width, height } = img;
  if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
    const scale = MAX_IMAGE_DIM / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(img, 0, 0, width, height);

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas encoding failed'))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });

  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('could not encode resized photo'));
    reader.readAsDataURL(blob);
  });

  return { base64, mimeType: 'image/jpeg', sizeKb: Math.round(blob.size / 1024) };
}

async function submitCamera() {
  if (!submissionState.enabled) {
    setSubmissionStatus('Configure your Supabase URL and anon key to enable submissions.', 'error');
    return;
  }
  if (!submissionState.photoFile) {
    setSubmissionStatus('Add a photo before submitting.', 'error');
    return;
  }
  if (submissionState.selectedLat == null || submissionState.selectedLng == null) {
    setSubmissionStatus('Click the map or use your current location to choose where the camera is.', 'error');
    return;
  }

  submissionUi.submitBtn.disabled = true;
  setSubmissionStatus('Preparing photo (resizing and stripping metadata)…');

  try {
    const { base64, mimeType, sizeKb } = await processImageForUpload(submissionState.photoFile);
    setSubmissionStatus(`Classifying the photo with AI (${sizeKb} KB)…`);
    const res = await fetch(`${config.supabaseUrl}/functions/v1/${config.submitCameraFunction}`, {
      method: 'POST',
      headers: getRequestHeaders(),
      body: JSON.stringify({
        imageBase64: base64,
        imageMimeType: mimeType,
        lng: submissionState.selectedLng,
        lat: submissionState.selectedLat,
        bearing: getSubmissionBearing(),
      }),
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload.error || `submit failed (${res.status})`);
    }

    state.user.cameras = null;
    state.user.error = null;
    await loadSource('user');

    clearSelectedLocation();
    clearPreview();
    setSubmissionStatus(payload.published ? 'Camera added to the map.' : 'Submitted for review. It will appear once the AI sanity check passes.');
  } catch (err) {
    setSubmissionStatus(err.message || 'Submission failed.', 'error');
  } finally {
    submissionUi.submitBtn.disabled = false;
  }
}

async function reportCamera(cameraId) {
  const res = await fetch(`${config.supabaseUrl}/rest/v1/rpc/report_camera`, {
    method: 'POST',
    headers: getRequestHeaders(),
    body: JSON.stringify({ camera_id: cameraId }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`report failed (${res.status}): ${detail}`);
  }

  state.user.cameras = null;
  state.user.error = null;
  await loadSource('user');
  setSubmissionStatus('Thanks. That submission has been flagged for review.');
}

function attachReportHandlers() {
  map.on('popupopen', (ev) => {
    const button = ev.popup.getElement()?.querySelector('.report-btn');
    if (!button) return;

    button.addEventListener('click', async () => {
      const cameraId = button.dataset.cameraId;
      if (!cameraId) return;
      button.disabled = true;
      try {
        await reportCamera(cameraId);
      } catch (err) {
        setSubmissionStatus(err.message || 'Report failed.', 'error');
      }
    }, { once: true });
  });
}

function registerSubmissionUi() {
  setSubmissionEnabled(submissionState.enabled);

  submissionUi.photoInput.addEventListener('change', (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    submissionState.photoFile = file;

    if (submissionState.previewUrl) URL.revokeObjectURL(submissionState.previewUrl);
    submissionState.previewUrl = URL.createObjectURL(file);
    submissionUi.photoPreview.src = submissionState.previewUrl;
    submissionUi.photoPreview.hidden = false;
    setSubmissionStatus('Photo ready. Choose a location and submit.');
  });

  submissionUi.useLocationBtn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      setSubmissionStatus('Geolocation is not available in this browser.', 'error');
      return;
    }
    setSubmissionStatus('Locating you…');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        showSelectedLocation(position.coords.latitude, position.coords.longitude);
        setSubmissionStatus('Location captured. Submit when ready.');
      },
      () => setSubmissionStatus('Unable to use your current location. Click the map to set it manually.', 'error'),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });

  submissionUi.submitBtn.addEventListener('click', submitCamera);

  submissionUi.bearingOmni.addEventListener('change', updateBearingDisplay);
  submissionUi.bearingSlider.addEventListener('input', updateBearingDisplay);
  updateBearingDisplay();

  map.on('click', (event) => {
    showSelectedLocation(event.latlng.lat, event.latlng.lng);
    setSubmissionStatus('Location selected. Upload a photo and submit.');
  });
}

registerSubmissionUi();
attachReportHandlers();
loadAllEnabled();
