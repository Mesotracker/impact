// Map-tile stitching utilities with instantaneous zero-latency basemap rendering
// and progressive live tile enhancement. Center pixel is exactly Ground Zero (lat/lng).

export const TILE_SIZE = 256;
export const MAP_CANVAS_SIZE = 1536; // 6x6 tiles @256px

export type TileTheme = 'dark' | 'voyager';

export function metersPerPixel(lat: number, zoom: number) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

export function latLngToWorldPixel(lat: number, lng: number, zoom: number) {
  const clamped = Math.max(-85.0511, Math.min(85.0511, lat));
  const s = Math.sin((clamped * Math.PI) / 180);
  const world = TILE_SIZE * Math.pow(2, zoom);
  const x = ((lng + 180) / 360) * world;
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world;
  return { x, y, world };
}

export function chooseZoom(lat: number, desiredExtentKm: number): number {
  for (let z = 16; z >= 3; z--) {
    const covered = (MAP_CANVAS_SIZE * metersPerPixel(lat, z)) / 1000;
    if (covered >= desiredExtentKm) return z;
  }
  return 3;
}

const SUBS = ['a', 'b', 'c'];

function getTileUrls(theme: TileTheme, z: number, x: number, y: number): string[] {
  const sub = SUBS[Math.abs(x + y) % SUBS.length];
  if (theme === 'voyager') {
    return [
      `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
      `https://${sub}.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`,
      `https://${sub}.tile.openstreetmap.fr/hot/${z}/${x}/${y}.png`,
    ];
  }
  return [
    `https://${sub}.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`,
    `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    `https://${sub}.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`,
  ];
}

function loadSingleUrl(url: string, timeoutMs = 2200): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => {
      img.src = '';
      resolve(null);
    }, timeoutMs);

    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = url;
  });
}

async function loadTileWithFallback(theme: TileTheme, z: number, x: number, y: number): Promise<HTMLImageElement | null> {
  const urls = getTileUrls(theme, z, x, y);
  for (const url of urls) {
    const img = await loadSingleUrl(url, 2000);
    if (img) return img;
  }
  return null;
}

function makeRng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return (s >>> 0) / 4294967296;
  };
}

function hashSeed(lat: number, lng: number) {
  const a = Math.round(lat * 10000) | 0;
  const b = Math.round(lng * 10000) | 0;
  return ((a * 374761393) ^ (b * 668265263)) >>> 0;
}

/** Draws a high-visibility, crisp vector basemap so terrain is immediately bright and legible */
export function drawInstantBasemap(
  ctx: CanvasRenderingContext2D,
  S: number,
  lat: number,
  lng: number,
  theme: TileTheme = 'dark',
  extentKm = 50
) {
  const rnd = makeRng(hashSeed(lat, lng));
  const isLight = theme === 'voyager';

  // Base ground fill with vibrant ambient tone
  ctx.fillStyle = isLight ? '#dbe2e8' : '#141c28';
  ctx.fillRect(0, 0, S, S);

  // Broad land / topography ambient radial gradient
  const grad = ctx.createRadialGradient(S / 2, S / 2, S * 0.05, S / 2, S / 2, S * 0.75);
  if (isLight) {
    grad.addColorStop(0, '#f0f3f6');
    grad.addColorStop(0.4, '#e4ebdf');
    grad.addColorStop(0.8, '#d6dee6');
    grad.addColorStop(1, '#c8d4df');
  } else {
    grad.addColorStop(0, '#1d2a3a');
    grad.addColorStop(0.4, '#1b2d24');
    grad.addColorStop(0.8, '#141c28');
    grad.addColorStop(1, '#0e141e');
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, S, S);

  // Coastline or primary water body
  const hasWater = rnd() > 0.2;
  if (hasWater) {
    ctx.fillStyle = isLight ? 'rgba(84, 158, 235, 0.75)' : 'rgba(38, 92, 142, 0.85)';
    ctx.beginPath();
    const waterSide = rnd() > 0.5 ? 0 : S;
    ctx.moveTo(waterSide, 0);
    let wx = waterSide === 0 ? S * 0.25 : S * 0.75;
    ctx.lineTo(wx, 0);
    for (let y = 0; y <= S; y += S / 16) {
      wx += (rnd() - 0.5) * S * 0.14;
      wx = Math.max(S * 0.05, Math.min(S * 0.95, wx));
      ctx.lineTo(wx, y);
    }
    ctx.lineTo(waterSide, S);
    ctx.closePath();
    ctx.fill();

    // Shoreline surf line
    ctx.strokeStyle = isLight ? 'rgba(255, 255, 255, 0.9)' : 'rgba(96, 175, 240, 0.8)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // Meandering river
  ctx.strokeStyle = isLight ? 'rgba(64, 140, 220, 0.85)' : 'rgba(48, 120, 185, 0.9)';
  ctx.lineWidth = S * (0.012 + rnd() * 0.008);
  ctx.beginPath();
  let rx = (0.2 + rnd() * 0.6) * S;
  ctx.moveTo(rx, 0);
  for (let y = 0; y <= S; y += S / 12) {
    rx += (rnd() - 0.5) * S * 0.2;
    rx = Math.max(S * 0.05, Math.min(S * 0.95, rx));
    ctx.lineTo(rx, y);
  }
  ctx.stroke();

  // Green spaces & parks
  ctx.fillStyle = isLight ? 'rgba(128, 196, 120, 0.6)' : 'rgba(34, 82, 48, 0.7)';
  for (let i = 0; i < 9; i++) {
    const cx = rnd() * S,
      cy = rnd() * S,
      rr = S * (0.04 + rnd() * 0.07);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rr, rr * (0.5 + rnd() * 0.7), rnd() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = isLight ? 'rgba(100, 170, 95, 0.5)' : 'rgba(45, 105, 62, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Dense urban & suburban street grid
  const cell = S / 28;
  ctx.strokeStyle = isLight ? 'rgba(145, 160, 180, 0.55)' : 'rgba(120, 150, 185, 0.45)';
  ctx.lineWidth = 1.2;
  for (let x = 0; x <= S; x += cell) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, S);
    ctx.stroke();
  }
  for (let y = 0; y <= S; y += cell) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(S, y);
    ctx.stroke();
  }

  // Major arterial expressways / highways
  ctx.strokeStyle = isLight ? 'rgba(245, 166, 35, 0.95)' : 'rgba(240, 195, 105, 0.85)';
  ctx.lineWidth = 3.8;
  for (let i = 0; i < 4; i++) {
    const x = ((i + 1) / 5 + (rnd() - 0.5) * 0.08) * S;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, S);
    ctx.stroke();
    const y = ((i + 1) / 5 + (rnd() - 0.5) * 0.08) * S;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(S, y);
    ctx.stroke();
  }

  // Secondary ring roads
  ctx.strokeStyle = isLight ? 'rgba(255, 255, 255, 0.85)' : 'rgba(195, 215, 240, 0.65)';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S * 0.28, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S * 0.44, 0, Math.PI * 2);
  ctx.stroke();

  // Downtown high-density building footprints
  for (let i = 0; i < 420; i++) {
    const x = rnd() * S,
      y = rnd() * S;
    const dist = Math.hypot(x - S / 2, y - S / 2) / (S * 0.7);
    if (rnd() > 0.65 - 0.4 * (1 - dist)) continue;
    const w = cell * (0.35 + rnd() * 0.55),
      h = cell * (0.35 + rnd() * 0.55);
    ctx.fillStyle = isLight
      ? rnd() > 0.8 ? 'rgba(235, 120, 40, 0.7)' : 'rgba(95, 115, 140, 0.55)'
      : rnd() > 0.8 ? 'rgba(255, 220, 140, 0.75)' : 'rgba(110, 138, 175, 0.65)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = isLight ? 'rgba(70, 85, 105, 0.4)' : 'rgba(180, 205, 235, 0.35)';
    ctx.lineWidth = 0.8;
    ctx.strokeRect(x, y, w, h);
  }

  // Prominent Ground Zero Reticle
  ctx.strokeStyle = 'rgba(249, 115, 22, 0.95)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, 14, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, 28, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(S / 2 - 36, S / 2);
  ctx.lineTo(S / 2 + 36, S / 2);
  ctx.moveTo(S / 2, S / 2 - 36);
  ctx.lineTo(S / 2, S / 2 + 36);
  ctx.stroke();

  // Cartographic scale bar in bottom-left corner
  ctx.fillStyle = isLight ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.85)';
  ctx.font = 'bold 13px monospace';
  const scaleText = `${(extentKm / 4).toFixed(0)} km`;
  ctx.fillText(scaleText, 36, S - 32);
  ctx.fillRect(36, S - 26, S * 0.15, 4);
}

export interface MapBuildResult {
  canvas: HTMLCanvasElement;
  zoom: number;
  extentKm: number;
  mpp: number;
  loaded: number;
  total: number;
  synthetic: boolean;
  theme: TileTheme;
}

const canvasCache = new Map<string, MapBuildResult>();

export function buildMapCanvas(
  lat: number,
  lng: number,
  desiredExtentKm: number,
  theme: TileTheme = 'dark',
  onProgress?: (loaded: number, total: number) => void,
  cancelled?: () => boolean,
  onTilePasted?: () => void
): { initial: MapBuildResult; promise: Promise<MapBuildResult> } {
  const zoom = chooseZoom(lat, desiredExtentKm);
  const cacheKey = `${lat.toFixed(5)},${lng.toFixed(5)},z${zoom},${theme}`;
  const cached = canvasCache.get(cacheKey);

  const mpp = metersPerPixel(lat, zoom);
  const extentKm = (MAP_CANVAS_SIZE * mpp) / 1000;
  const S = MAP_CANVAS_SIZE;

  // 1. Immediately create and paint the procedural basemap
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d', { willReadFrequently: false })!;
  drawInstantBasemap(ctx, S, lat, lng, theme, extentKm);

  const initialResult: MapBuildResult = {
    canvas,
    zoom,
    extentKm,
    mpp,
    loaded: cached ? cached.total : 0,
    total: cached ? cached.total : 1,
    synthetic: !cached,
    theme,
  };

  if (cached) {
    // Already cached - copy into canvas and resolve immediately
    ctx.drawImage(cached.canvas, 0, 0);
    onProgress?.(cached.total, cached.total);
    return {
      initial: { ...cached, canvas },
      promise: Promise.resolve({ ...cached, canvas }),
    };
  }

  // 2. Asynchronously stream live tiles and draw them over the procedural base
  const { x: cx, y: cy } = latLngToWorldPixel(lat, lng, zoom);
  const x0 = cx - S / 2;
  const y0 = cy - S / 2;
  const txMin = Math.floor(x0 / TILE_SIZE);
  const txMax = Math.floor((x0 + S - 1) / TILE_SIZE);
  const tyMin = Math.floor(y0 / TILE_SIZE);
  const tyMax = Math.floor((y0 + S - 1) / TILE_SIZE);
  const worldTiles = Math.pow(2, zoom);

  type Job = { tx: number; ty: number; dx: number; dy: number };
  const jobs: Job[] = [];
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      jobs.push({ tx, ty, dx: tx * TILE_SIZE - x0, dy: ty * TILE_SIZE - y0 });
    }
  }

  const total = jobs.length;
  let loaded = 0;
  let succeeded = 0;
  onProgress?.(0, total);

  const promise = (async (): Promise<MapBuildResult> => {
    const CONC = 6;
    let idx = 0;

    async function worker() {
      while (idx < jobs.length) {
        if (cancelled?.()) return;
        const j = jobs[idx++];
        const wrappedX = ((j.tx % worldTiles) + worldTiles) % worldTiles;
        if (j.ty >= 0 && j.ty < worldTiles) {
          const img = await loadTileWithFallback(theme, zoom, wrappedX, j.ty);
          if (cancelled?.()) return;
          if (img) {
            ctx.drawImage(img, j.dx, j.dy, TILE_SIZE, TILE_SIZE);
            succeeded++;
            onTilePasted?.();
          }
        }
        loaded++;
        onProgress?.(loaded, total);
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONC, total) }, () => worker()));

    if (cancelled?.()) {
      return { canvas, zoom, extentKm, mpp, loaded, total, synthetic: false, theme };
    }

    const synthetic = succeeded / total < 0.35;
    if (synthetic && succeeded > 0) {
      // If only a few tiles succeeded, redraw the reticle to ensure clean center
      ctx.strokeStyle = 'rgba(249, 115, 22, 0.85)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(S / 2, S / 2, 14, 0, Math.PI * 2);
      ctx.stroke();
    }

    const finalResult: MapBuildResult = { canvas, zoom, extentKm, mpp, loaded, total, synthetic, theme };
    canvasCache.set(cacheKey, finalResult);
    if (canvasCache.size > 12) {
      const oldest = canvasCache.keys().next().value;
      if (oldest) canvasCache.delete(oldest);
    }
    return finalResult;
  })();

  return { initial: initialResult, promise };
}
