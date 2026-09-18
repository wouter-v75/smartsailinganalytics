'use client'
// Compatibility barrel.
//
// This module used to BE the app: ~9,600 lines holding SSAApp and every
// component and helper it shares. Those now live in files of their own (see
// ./SSAApp, ./UploadTab, ./AnalyticsTab, ./GPSTrackMap, ./video/*, ./sync/*,
// ./charts/*, ./mobile/*, ./ssa/*). Only four symbols were ever imported from
// here, so the barrel stays and keeps their import paths working:
//
//   default        src/app/page.tsx
//   GPSTrackMap    src/app/dev/track/page.tsx
//   MobileShell    src/app/dev/shell/page.tsx
//   BatchSyncPanel src/components/__tests__/BatchSyncPanel.test.tsx
//
// New code should import from the component's own file rather than through
// here — this exists so the split did not have to touch its callers.
export { default } from './SSAApp';
export { GPSTrackMap } from './GPSTrackMap';
export { MobileShell } from './mobile/MobileShell';
export { BatchSyncPanel } from './sync/BatchSyncPanel';
