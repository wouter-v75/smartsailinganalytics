'use client'
import * as React from 'react'
import dynamic from 'next/dynamic'

// ssr:false for the same reason src/app/page.tsx uses it for the real app: the
// shell is entirely client-side (IndexedDB, blob URLs, local clocks) and server
// rendering it only produces hydration mismatches.
const MobileShell = dynamic(
  () => import('@/components/SmartSailingAnalytics_UI').then((m) => m.MobileShell),
  { ssr: false }
)

// Preview harness for the PHONE SHELL itself — the bottom tab bar and the panes
// it switches between — with fixture props and no signed-in session.
//
// /dev/tagger renders the tagging components on their own; this renders the
// shell they live inside, which is where tab-visibility and pane-layout bugs
// actually happen. Both are dev-only (see isAlwaysPublic in src/middleware.ts).

const noop = () => {}

// A spy the browser check reads back: clicking a clip on the Analytics tab must
// call this and must NOT navigate to a Videos tab that no longer exists.
const playClipInModal = (clip: unknown) => {
  ;(window as unknown as Record<string, unknown>).__playedClip = clip
}

const T0 = Date.parse('2026-09-11T11:00:00Z')
const rows = Array.from({ length: 600 }, (_, i) => ({
  utc: T0 + i * 1000,
  lat: 43.05 + i * 1e-5, lon: 9.85 + i * 1e-5,
  tws: 12 + Math.sin(i / 40) * 2, twa: 45, twd: 220,
  bsp: 8 + Math.sin(i / 30), sog: 8.2, cog: 40, hdg: 40,
  vmg: 5.4, heel: 18, awa: 28, aws: 18, rudder: 2, trim: 0,
}))
const asyncNoop = async () => {}

const props: Record<string, unknown> = {
  role: 'coach',
  effectiveRole: 'coach',
  perms: { canImport: true, canSync: true, canDelete: true },
  // One clip that lives on this device, so the Upload pane's cloud-push panel
  // has something to offer.
  allVideos: [{ id:'v1', title:'R1 start.mp4', hasLocalBlob:true, duration:180,
                startUtc: T0 + 60_000, sessionDate:'2026-09-11', tags:[],
                twsAvg: 12.4, twaAvg: 45, vmgAvg: 5.4, polpercAvg: 96, vsTargPercAvg: 98 }],
  setAllVideos: noop,
  sessions: [], setSessions: noop,
  activeDate: '2026-09-11', setActiveDate: noop,
  selectedVideo: null, setSelectedVideo: noop,
  logData: { rows, source: 'local', startUtc: T0, endUtc: T0 + 599_000 }, setLogData: noop,
  xmlData: null, setXmlData: noop,
  sessionTzOffset: 120,
  sessionTagList: [], setSessionTagList: noop,
  syncOffsets: {}, setSyncOffsets: noop,
  saveSyncForVideos: asyncNoop, saveTagsForVideo: asyncNoop,
  tagSuggestionList: [],
  cloudStatus: { available: true, storage: true, stream: true },
  unsyncedCount: 0,
  searchQuery: '', setSearchQuery: noop,
  sortBy: 'time', setSortBy: noop,
  selectedTags: [], setSelectedTags: noop,
  allTags: [], isManTag: () => true, toggleTag: noop,
  displayed: [],
  loadDate: asyncNoop, onSelectDate: asyncNoop, handleImported: noop,
  handlePlayUtc: noop, playUtc: null,
  canSeeAnalytics: true, canUseAI: false,
  canSeeSailScanTab: true, canSeeSquashShotsTab: true,
  canSeeToolsTab: true, canSeeBoatConfig: true,
  canSeeAnalyticsData: true, canSeeSailScanPhotos: true,
  showOnlyLatestDay: false,
  campaignOn: true,
  campaignCfg: { teamId: 'team-fixture', boatId: 'boat-fixture', boatName: 'Fixture', event: 'Dev week' },
  activeMem: { team_id: 'team-fixture', boat_id: 'boat-fixture' },
  openCampaignVideo: asyncNoop, openVideoModal: asyncNoop,
  playClipInModal, myUid: 'me',
  sailInventory: [], setSailDiff: noop,
  onRotateVideo: null,
  hasMountedAnalytics: true,
  updateVideoTagsFn: asyncNoop, computeAutoTagsFn: () => [],
  photos: [], setPhotos: noop,
  onMobileSync: noop, onSyncProxies: noop, onUploadOriginals: noop,
  syncErrors: [],
  mobileSyncState: null, setMobileSyncState: noop,
  onThumbLoad: noop, videoThumbsLoading: false,
  videoLoadedIds: [], videoTotalThumbs: 0,
  onRecheckStream: asyncNoop,
}

export default function ShellPreview() {
  const [activeTab, setActiveTab] = React.useState('tagger')
  return <MobileShell {...props} activeTab={activeTab} setActiveTab={setActiveTab} />
}
