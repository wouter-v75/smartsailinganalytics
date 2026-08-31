// Raster basemap tiles for the 2D Leaflet maps and the PDF deck's coastline.
//
// We used to pull CARTO's dark_all / light_all raster tiles. As of Aug 2026
// CARTO stopped serving those anonymously: the CDN still answers 200, but the
// PNG it returns is a black "API KEY REQUIRED" watermark, so the maps silently
// turned to mush rather than erroring. CARTO is also retiring raster tiles in
// favour of vector styles, so keying it would only buy time.
//
// Esri's Canvas basemaps are keyless, send `Access-Control-Allow-Origin: *`
// (the deck composites tiles into a canvas it exports, so CORS matters), and
// the app already leans on ArcGIS for the 3D satellite drape. Base + Reference
// are separate layers: the base has land/water/roads, the reference has the
// place labels on top.
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas'

export const DARK_BASE_TILES = `${ESRI}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`
export const DARK_LABEL_TILES = `${ESRI}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`
export const LIGHT_BASE_TILES = `${ESRI}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`
export const LIGHT_LABEL_TILES = `${ESRI}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`

// The Canvas caches stop at z16; Leaflet upscales the z16 tile above that.
export const BASEMAP_MAX_NATIVE_ZOOM = 16
export const BASEMAP_ATTRIBUTION = '© Esri, HERE, Garmin, © OpenStreetMap contributors'

// {z}/{y}/{x} for a single tile — the deck fetches tiles by hand rather than
// through Leaflet, so it needs the substitution done for it.
export function tileUrl(template, z, x, y) {
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y)
}

// Add the dark Canvas base + its label layer to a Leaflet map. `opts` is
// spread into both tileLayer calls (maxZoom, pane, …).
export function addDarkBasemap(L, map, opts = {}) {
  const common = { attribution: BASEMAP_ATTRIBUTION, maxNativeZoom: BASEMAP_MAX_NATIVE_ZOOM, ...opts }
  L.tileLayer(DARK_BASE_TILES, common).addTo(map)
  L.tileLayer(DARK_LABEL_TILES, common).addTo(map)
}
