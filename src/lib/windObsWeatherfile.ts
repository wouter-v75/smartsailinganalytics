// WeatherFile.com — the western Solent, which nothing else covers.
//
// WHY IT MATTERS. Every other source we have clusters round Cowes, Southampton
// Water and the eastern approaches. West of Gurnard there is almost nothing:
// no Davis garden station on the Hurst shore, no Port-Log site past Calshot,
// no METAR nearer than Bournemouth. WeatherFile has the four that matter for
// racing out of Lymington — the RLymYC STARTING PLATFORM itself, Hurst Castle
// in the narrows, Yarmouth Pier across the channel, and Lymington Yacht Haven
// — plus Hythe, Stokes Bay, Calshot, Highcliffe and the Parkstone platform.
//
// THE ENDPOINT. One POST per location:
//
//   POST https://weatherfile.com/api/V03/loc/<locId>/averages.json
//   header  wf-tkn: <token>
//
// It answers with the WHOLE DAY at five-minute resolution, newest last, which
// is why this is worth having twice over: the newest row is the map, and the
// rest is a 6-hour graph that exists from the first poll rather than filling
// in over hours.
//
// UNITS, PINNED AGAINST A THIRD PARTY. `wsa`/`wsh`/`wsl` are mean, gust and
// lull in METRES PER SECOND, and `wda` is the direction. None of that is
// stated in the payload, so it was measured rather than assumed, and measured
// twice because one comparison is how the Met Office units went wrong earlier:
//
//   - The values do not move when the site's own unit preference is flipped
//     from m/s to knots, so they are a fixed base unit rather than whatever
//     the viewer last chose.
//   - At 05:10 UTC on 23 Oct 2026, GBR00001 gave wsa 9.10, wsh 11.37, wda 128.
//     Times 1.943844 that is 17.7 kn, 22.1 kn, 128° — which is exactly what
//     Windycator published for the same station at the same minute, to the
//     decimal, having got there independently.
//
// Two numbers agreeing to 0.1 kn across two routes is a measurement. One
// station looking plausible is not.
//
// `wdb` and `wdv` (110 and 140 on that row) bracket `wda` — the direction
// range over the period, not another mean. They are left alone.
//
// THE CLOCK IS UTC, which for this project is never assumed. The same
// cross-match settles it: Windycator stamped that row 06:10+01:00 and the
// row's own `ts` reads 05:10:00. A row is also never in the future, so a feed
// that started publishing local time would put its newest row an hour ahead
// and `parseWeatherfile` refuses it rather than drawing it.
//
// ACCESS. The API needs a `wf-tkn`. Their own page gets a six-character one
// tied to a PHP session, and the reply calls it `"token": "PUBLIC"` — these
// locations are not paywalled. But minting a session token from their page on
// a 30-minute loop is scripting around an access control on somebody's
// commercial service, so this reads WEATHERFILE_TOKEN from the environment
// instead and returns NOTHING when it is absent. Without the key the whole
// source is structurally inert, the same way a missing BUNNY_STORAGE_WRITE_KEY
// makes the app read-only against Bunny. Ask support@weatherfile.com for a
// location API token; `/admin/location-api-tokens` is superadmin-only in their
// app, so asking is the route.

export interface WeatherfileStation {
  locId: string
  name: string
  lat: number
  lon: number
  /** Over open water, or behind buildings up a river. */
  surface: 'sea' | 'land'
}

export const WEATHERFILE_STATIONS: WeatherfileStation[] = [
  // The four that close the western Solent.
  { locId: 'GBR00001', name: 'Lymington Starting Platform', lat: 50.74033, lon: -1.507113, surface: 'sea' },
  { locId: 'GBR00002', name: 'Hurst Castle', lat: 50.706215, lon: -1.553685, surface: 'sea' },
  { locId: 'GBR00003', name: 'Yarmouth Pier', lat: 50.708582, lon: -1.499594, surface: 'sea' },
  { locId: 'GBR00008', name: 'Lymington Yacht Haven', lat: 50.750766, lon: -1.52976, surface: 'land' },
  // The rest of their Solent and Poole coverage, which comes free with the key.
  { locId: 'GBR00022', name: 'Hythe Pier', lat: 50.87479, lon: -1.393335, surface: 'sea' },
  { locId: 'GBR00065', name: 'Calshot Activities Centre', lat: 50.818, lon: -1.3077, surface: 'land' },
  { locId: 'GBR00074', name: 'Stokes Bay SC', lat: 50.781933, lon: -1.154412, surface: 'land' },
  { locId: 'GBR00004', name: 'Highcliffe SC', lat: 50.724468, lon: -1.741941, surface: 'land' },
  { locId: 'GBR00015', name: 'Parkstone YC Platform', lat: 50.706209, lon: -1.967978, surface: 'sea' },
  // DELIBERATELY NOT LISTED: GBR00158, the IoW Hang Gliding & Paragliding
  // Club at 50.651/-1.3745. Its newest reading on 23 Oct 2026 was eight days
  // old — a seasonal paraglider site, not a fault. Listed, it would cost 48
  // requests a day for a reading the 90-minute staleness window drops anyway.
  // The Davis registry drops dead stations at build time for the same reason.
]
