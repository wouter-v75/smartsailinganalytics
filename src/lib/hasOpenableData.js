
// A session is worth OFFERING when it holds anything openable — video, log,
// events or photos. Analytics and the sessions sidebar previously required
// (videoCount||0) > 0, so a day with only a logfile was filtered out of both
// even though the very next line rendered a "· log" badge for it: upload a log
// with no video and the day was invisible, with nothing to say why.
// The Videos grid deliberately keeps its own video-only test — a log-only day
// there would open an empty gallery.
const hasOpenableData = (s) =>
  (s?.videoCount || 0) > 0 || !!s?.hasLog || !!s?.hasXml || (s?.photoCount || 0) > 0;

export { hasOpenableData };