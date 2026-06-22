// weatherSession.js
// ----------------------------------------------------------------------------
// In-memory persistence for the Weather tab. WeatherTab unmounts when the user
// navigates to a different TOP-LEVEL tab (Campaign, etc.), which would otherwise
// drop the 3 forecast points, the fetched model data and the 2D wind/hpbl field.
// We mirror that state into a module-level singleton (lives for the whole browser
// session, no serialization) and re-seed WeatherTab's useState from it on remount,
// so switching tabs and coming back keeps everything in place.
//
// Not localStorage: the field object holds many frames of typed arrays — cheap to
// keep in memory, wasteful to serialize. Cleared only on a full page reload.
// ----------------------------------------------------------------------------

const store = {
  windData: {},
  activeModel: 'AROME',
  resolvedTz: 'UTC',
  mastHeight: 30,
  forecastPersist: {},   // { locations, fieldModel, fieldHeight, fieldHourIdx, field }
  soundingPoint: null,   // { lat, lon } — the Sounding tab's picked point, for the deck's Stability slide
}

export function getWeatherSession() {
  return store
}

export function patchWeatherSession(patch) {
  Object.assign(store, patch)
}
