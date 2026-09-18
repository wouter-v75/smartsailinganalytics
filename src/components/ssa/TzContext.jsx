'use client'
import React from "react";

// ── Venue-local clock ────────────────────────────────────────────────────────
// Everything is STORED in true UTC and rendered at venue-local (+ sessionTzOffset).
// Analytics used to render raw UTC, so its clocks read 2 h behind the timeline and
// the video player in CEST. Rather than thread the offset through LineChart /
// PerfChart / GPSTrackMap / AnalyticsTab by prop, publish it once on a context.
const TzCtx = React.createContext(0);

const useTz = () => React.useContext(TzCtx);

export { TzCtx, useTz };