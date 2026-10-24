// Public Davis stations near our venues, from weatherlink.com's own map.
//
// GENERATED, not hand-found — scripts/davis-map-refresh.ts rebuilds it. The
// index behind weatherlink.com/map lists ~79,500 public stations worldwide with
// their positions; this is the nearest few to each venue that were LIVE when
// the list was built.
//
// WHY A FILE AND NOT A LOOKUP. That index is 8.4 MB. Fetching it every quarter
// of an hour would be 0.8 GB a day off their server for data that changes when
// somebody installs an anemometer — and it is over Next's 2 MB fetch-cache
// limit, so it would genuinely refetch every time. Station positions are stable;
// the readings are not, and only the readings are polled.
//
// EVERY ENTRY IS CHECKED AT BUILD TIME, and that is not a formality. On the
// first build five of forty-eight candidates were dropped: LER and
// LPM-DOF-CICESE at Ensenada, last reporting 47 and 45 hours before;
// Beauvallon at St Tropez, 56 hours; Portorotondo at Porto Cervo, 9 hours; and
// a "Home" near Ensenada that publishes no wind at all. Listed unchecked they
// would have been silent absences on the map with nothing to say which — the
// same three-in-nine rate as the Solent club feeds.
//
// HOW MANY, AND WHY IT WAS WRONG. This held the nearest SIX per venue for its
// first day, which was never a coverage judgement — it was the live map's old
// fetch cap, copied. There are 124 public Davis stations within 20 nm of Cowes
// and the nearest 24 were all live when measured, so six was discarding a
// working network while Windycator showed 24 stations over the same water.
// The limit on going further is the POLLER, not the map: every station here is
// read on every poll, so at the half-hourly cadence (obsSources POLL_EVERY_MIN)
// 24 per venue across 12 venues is roughly 11,000 calls a day to somebody
// else's public endpoint. It was 22,000 at the quarter-hourly cadence, which is
// most of why the cadence changed.
//
// These are private stations their owners chose to publish: gardens, marinas,
// boatyards, a yacht club. They draw as `pws`, the lowest trust, because a good
// instrument in an unknown garden is exactly what that tier is for. Where one
// of them IS a curated embed (Gurnard and the NCI stations appear in both,
// under different ids), dropDuplicatesOf removes it by position.
//
// The block below is written by the script — do not edit it by hand. It used
// to say "built 22 Oct 2026" with a note to update the date and the tally
// manually, which is the kind of instruction that is wrong by the second run.
// <generated>
// 301 stations, graded: ALL within 5 nm, thinning to 4 nm spacing, coast bias 1.5
// at 50 nm. Built 24 Oct 2026.
// 3 of 23 candidates dropped as stale (over 180 min), silent or
// publishing no wind. Per venue:
//   Solent / Cowes: 24
//   Lymington: 15
//   St Tropez: 22
//   La Spezia: 23
//   San Juan Islands: 24
//   Long Beach / San Pedro: 24
//   Ensenada: 14
//   Viksfjord / Larvik: 15
//   Fredrikstad / Sarpsborg: 12
//   Oslofjord / Horten: 13
//   Oslo: 25
//   Sorrento: 70
//   Porto Cervo: 20
// </generated>

import type { WlMapStation } from './windObs'

export interface DavisMapStation extends WlMapStation {
  name: string
  /**
   * Distance from the sea in nautical miles, measured once against the
   * Open-Meteo elevation DEM (the same "coastline dataset" the forecast
   * diagnostics use). Present only where it was measured, which is where the
   * coast bias needed it: stations outside the inner circle of a venue that
   * was picked with --coast. Absent means NOT MEASURED, never "inland".
   */
  seaNm?: number
}

export const DAVIS_MAP_STATIONS: DavisMapStation[] = [
  // Solent / Cowes
  { id: '1d4ad0be-d14d-48fc-b96f-a2de82322d9d', name: "Sollars Marine Surveys", lat: 50.75862, lon: -1.30611 },  // 0.8 nm
  { id: 'd419c2cb-b56f-4de0-ad13-8f95cba9f6a0', name: "Lammas Lodge", lat: 50.76317, lon: -1.31524 },  // 1 nm
  { id: '97e86222-100e-4f42-a8b8-5b45bc074ecd', name: "Cowes", lat: 50.76317, lon: -1.31532 },  // 1.1 nm
  { id: 'ba239a3d-ac84-4781-b9bb-ec469549c4be', name: "GurnardSC", lat: 50.76036, lon: -1.32505 },  // 1.4 nm
  { id: '4b09f590-865c-4dcc-9f18-4f41be3c0bbe', name: "Alf HCG", lat: 50.74104, lon: -1.31442 },  // 1.8 nm
  { id: '55172bb1-ec6e-4769-808c-773ca7c35991', name: "@West Medina", lat: 50.72383, lon: -1.28469 },  // 2.5 nm
  { id: '43547943-90cf-4ac6-b0c6-a0ca32fc7092', name: "NCI Stone Point", lat: 50.78429, lon: -1.3534 },  // 2.7 nm
  { id: '7543cc0f-4a8a-468c-ac17-cc49d618c270', name: "@iwweather WL", lat: 50.72043, lon: -1.27066 },  // 2.8 nm
  { id: '1672a06a-9014-4df6-bd3d-ac9f508b10dd', name: "The Isle of Wight Weather Station (GBR)", lat: 50.72043, lon: -1.27066 },  // 2.8 nm
  { id: '99f92512-42c6-4926-b4bd-866270c4057b', name: "Live Newport @iwweather", lat: 50.72042, lon: -1.27063 },  // 2.8 nm
  { id: 'e0b0425f-7e11-4d70-bbc6-585914b4a625', name: "AF Station", lat: 50.70998, lon: -1.26 },  // 3.5 nm
  { id: '94955ba9-1f55-4964-8626-672c3ef51544', name: "NCI Lee onthe Solent", lat: 50.80063, lon: -1.20316 },  // 3.8 nm
  { id: '6cf3c317-9016-4a3f-9c1a-9c88c7510966', name: "Snow's Weather Home", lat: 50.70127, lon: -1.30901 },  // 4 nm
  { id: 'a8994c02-537a-489e-8168-130927c0fb7b', name: "Solent weather", lat: 50.80017, lon: -1.19676 },  // 4 nm
  { id: 'f0259617-b53e-4e42-a466-10a883af9be2', name: "Ash road-Newport", lat: 50.69851, lon: -1.28767 },  // 4 nm
  { id: '37c5e79e-1898-40aa-8d32-9d69cc9fcc7d', name: "Stubbington", lat: 50.82526, lon: -1.21774 },  // 4.4 nm
  { id: 'de0452ab-acd8-425b-bec7-244be1b392be', name: "QUAY HOUSE", lat: 50.85282, lon: -1.30713 },  // 5.3 nm
  { id: 'cf56a423-c487-4ad4-9ec4-4395086f9455', name: "David’s Home Live", lat: 50.85449, lon: -1.264 },  // 5.4 nm
  { id: 'dd0f6761-5b44-4aa7-b1e3-6ac95798918c', name: "River Hamble Harbour Master", lat: 50.85793, lon: -1.304 },  // 5.5 nm
  { id: 'ed6e6b07-e3a0-4d0e-ba0f-27741c8224c8', name: "MDL Port Hamble", lat: 50.86001, lon: -1.31165 },  // 5.7 nm
  { id: '53f951cd-42ba-4c8e-b795-82c1ffe5d0d0', name: "Hamble Cliff Lodge", lat: 50.86257, lon: -1.33755 },  // 6.1 nm
  { id: 'e4e87e88-ac6f-4228-8bfc-1077e924b467', name: "TyGwynLive", lat: 50.86827, lon: -1.26992 },  // 6.2 nm
  { id: '87accd2c-4dfd-437a-b730-4a4df3c66156', name: "Mercury Marina", lat: 50.87115, lon: -1.31252 },  // 6.4 nm
  { id: '229aef40-1652-4b5d-9d41-ac98247e5f0d', name: "Dibden Purlieu", lat: 50.85689, lon: -1.40667 },  // 7.1 nm
  // Lymington
  { id: 'ceb5a199-3107-4a25-adf3-bae466750afc', name: "Sway road, Lymington", lat: 50.76973, lon: -1.55644 },  // 2.4 nm
  { id: '5a2cfc3d-d04d-4b94-a734-40d77544800a', name: "Downtonweather", lat: 50.74076, lon: -1.61192 },  // 3 nm
  { id: 'b0072b5a-8ffd-4cca-8ee7-f7338cd9be9e', name: "The Coach House", lat: 50.74317, lon: -1.62919 },  // 3.7 nm
  { id: '74f82abc-1a92-41a8-bd23-b144d9b57b36', name: "Newlands Farm", lat: 50.78828, lon: -1.46228 },  // 4.3 nm
  { id: '66aef694-22b9-431e-bbdf-e433c5460c3b', name: "treehouse", lat: 50.74386, lon: -1.65857 },  // 4.8 nm
  { id: '102b5e09-6e84-4d62-b061-22fa5ae16834', name: "Rhinefield Close", lat: 50.82142, lon: -1.58406 },  // 5.6 nm
  { id: '3406d7de-43a5-41a2-b502-06fa620b7c1a', name: "FOH Office", lat: 50.81948, lon: -1.45241 },  // 6 nm
  { id: '3a8f31cb-3ab0-4dbf-8a3a-098273193139', name: "Wilverley Road Wootton", lat: 50.78939, lon: -1.66691 },  // 6.1 nm
  { id: '77aa3237-e034-4045-b82f-775e8d770e46', name: "Blue Box Weather", lat: 50.75825, lon: -1.7052 },  // 6.7 nm
  { id: '21c17617-1fc0-49d1-855f-ca88f7605519', name: "Brighstone", lat: 50.63992, lon: -1.39876 },  // 7.6 nm
  { id: 'b3bf39b8-f986-4c0c-b007-5a0a11db7bfb', name: "Mudefordseascouts", lat: 50.73146, lon: -1.75767 },  // 8.5 nm
  { id: '4ca95bbe-561b-48e8-a7c9-a02ee0d7af85', name: "Wayside Weather", lat: 50.76414, lon: -1.75389 },  // 8.6 nm
  { id: '6a9d3b2d-a205-47c0-a0b2-5c505190ec36', name: "NCI Hengistbury Head", lat: 50.71519, lon: -1.75878 },  // 8.6 nm
  { id: '11efadc8-a767-4283-9204-80f220f3af13', name: "FIRCROFT", lat: 50.75036, lon: -1.77036 },  // 9.1 nm
  { id: '48d99cf1-1607-46a4-90e4-50ae8308734a', name: "Castle Hill", lat: 50.83163, lon: -1.71896 },  // 9.2 nm
  // St Tropez
  { id: '92e78f95-aa6a-407b-969f-c35224e68fad', name: "Yacht Club de Saint-Tropez", lat: 43.26634, lon: 6.66815 },  // 1.3 nm
  { id: '60a4f639-ad11-47e4-9d38-303add35d94a', name: "GASSIN", lat: 43.25866, lon: 6.57056 },  // 5.6 nm
  { id: 'ac22feda-189b-484a-b661-d8dc33ec80d9', name: "VallonVert", lat: 43.30928, lon: 6.5519 },  // 6.9 nm
  { id: '7782a0b2-1300-4ffd-b35f-07a7c9755a10', name: "Tadasana", lat: 43.35522, lon: 6.5508 },  // 8.3 nm
  { id: '5fb52b1e-3f27-4ee0-b53c-c8393a1d6d00', name: "Maison des Chiens", lat: 43.34059, lon: 6.53362 },  // 8.4 nm
  { id: '7a51d024-966d-4968-844a-a6b10d059453', name: "Collège A. Karr", lat: 43.43375, lon: 6.76904 },  // 10.5 nm
  { id: '69ba57bd-b1c9-48ac-af9b-d1a2e07bc4d3', name: "PUGET SUR ARGENS", lat: 43.45968, lon: 6.70019 },  // 11.6 nm
  { id: '35021a3c-d619-477a-a96f-d5a701d1fad9', name: "Le Blavet", lat: 43.47272, lon: 6.64507 },  // 12.6 nm
  { id: '4663f5f3-6e47-4583-9314-16d5d816cba9', name: "Elogia83", lat: 43.46553, lon: 6.45514 },  // 16 nm
  { id: '08361265-d5c1-4cfb-bb26-6052f08eae22', name: "Sikoy", lat: 43.13599, lon: 6.37355 },  // 16.2 nm
  { id: '5c29feba-5732-4a42-bcfd-2159dc6d7531', name: "Capitainerie Port du Lavandou", lat: 43.13659, lon: 6.37302 },  // 16.2 nm
  { id: '84756536-fa30-4c6f-8a66-1045e17e5ac8', name: "Collobrières - Le stade", lat: 43.23756, lon: 6.31771 },  // 16.7 nm
  { id: '2cca8e1d-1348-41d7-a02a-a809e1f95e1e', name: "lloydburl", lat: 43.45606, lon: 6.41191 },  // 16.9 nm
  { id: '8efffc13-f002-4784-9a08-40616dee385b', name: "Collobrieres - Vaudreches", lat: 43.24843, lon: 6.31337 },  // 16.9 nm
  { id: '53678bb8-617d-4836-9b04-303c948ef481', name: "Ventose1", lat: 43.15008, lon: 6.34626 },  // 16.9 nm
  { id: '2d48d2d8-c60e-4f5d-ad25-3a5b80a94ea7', name: "Callas - Carrière de la Catalane", lat: 43.53815, lon: 6.56186 },  // 17.3 nm
  { id: '8b8faeb3-abc4-4d76-a82f-ffd4abd4a9b4', name: "Pointe du Pinet", lat: 43.09975, lon: 6.36555 },  // 17.7 nm
  { id: '17eb675d-dd7c-4daf-97a4-9e86ff18cc60', name: "Floraluc / Le Luc-en-Provence / Météo Varoise", lat: 43.37644, lon: 6.30938 },  // 18.2 nm
  { id: '10826c76-8445-48e5-b7f3-4b49d7da2824', name: "Marsanne Figa", lat: 43.55288, lon: 6.51608 },  // 18.9 nm
  { id: '6127f800-74a7-42fd-a6af-4bb5d3cc7bb6', name: "romain83440", lat: 43.61295, lon: 6.77623 },  // 21 nm
  { id: '976911c6-1a4d-4e20-9267-d50a3c939d0e', name: "La Vieille Londe *", lat: 43.14144, lon: 6.2384 },  // 21.5 nm
  { id: '92eb3908-8d10-4942-96b0-b3a766ce0212', name: "La Vieille Londe", lat: 43.14145, lon: 6.23836 },  // 21.5 nm
  // La Spezia
  { id: '28ad6c9c-4287-49cc-8444-31b729d8d9cc', name: "Porticciolo Diportisti Morin", lat: 44.10265, lon: 9.82567 },  // 0.2 nm
  { id: 'c0103a5f-a02f-4c81-904c-f06fc0c58ece', name: "GRAVEGLIA", lat: 44.15472, lon: 9.78226 },  // 3.9 nm
  { id: '8aa03c52-99c2-42f9-ae62-9c1cc77d4efe', name: "Deposito di Arcola", lat: 44.1214, lon: 9.91852 },  // 4 nm
  { id: '33c5cc27-db46-486b-a300-0a58b1f225a7', name: "SSM-WS02", lat: 44.14838, lon: 9.91228 },  // 4.6 nm
  { id: '185a7c34-0ae7-4c7e-aefa-144cbfed7517', name: "SSM-WS01", lat: 44.14931, lon: 9.91386 },  // 4.7 nm
  { id: '431798c4-eb25-4e0f-916e-d4fb0c62c5f6', name: "SARZANA - SANTA CATERINA", lat: 44.12083, lon: 9.95312 },  // 5.4 nm
  { id: '8dd72f18-7c2e-4d2d-9f5f-1cec278ebebd', name: "Sarzana (Italy) - Bomberini’s Home", lat: 44.11485, lon: 9.9811 },  // 6.6 nm
  { id: 'faceb842-62ca-4b3e-88ae-1c25ff7c2031', name: "MeteoSarzana WeatherLink Live", lat: 44.10788, lon: 9.98249 },  // 6.6 nm
  { id: '4f23d33f-19bd-4efd-a1c7-d629de3a623c', name: "Wscfconsole", lat: 44.04701, lon: 9.99214 },  // 7.7 nm
  { id: 'b57f133b-197e-4543-b961-6e5a83589c21', name: "Marina di Carrara (MS)", lat: 44.04831, lon: 10.04168 },  // 9.6 nm
  { id: '41057535-b63a-433b-b309-34b9f23bdaa5', name: "Camping Acquadolce", lat: 44.16605, lon: 9.61398 },  // 10.1 nm
  { id: 'b81e0400-9e36-4b03-b15f-0461088fe0bf', name: "Labanalysis Avenza", lat: 44.0392, lon: 10.07649 },  // 11.2 nm
  { id: '5c3966fd-c0a5-4b62-8f62-4f27e763cc69', name: "spondarella", lat: 44.05993, lon: 10.08824 },  // 11.4 nm
  { id: '3c35cc79-f22a-4ab4-be53-01bfca9a0cb4', name: "Bagni San Giorgio BONASSOLA", lat: 44.18308, lon: 9.58197 },  // 11.8 nm
  { id: 'aa5d3339-110f-44e2-81ce-c213256a1ad3', name: "Folegnano | Terre dei Bianchi", lat: 44.1829, lon: 10.11922 },  // 13.4 nm
  { id: '0faa653a-2f33-403e-9ac6-fd4491ac7c83', name: "Folegnano [Terre dei Bianchi]", lat: 44.18293, lon: 10.11929 },  // 13.4 nm
  { id: 'd7e0a49b-0365-48b1-beab-4ade28ffe5d5', name: "Carbonera B79", lat: 44.09363, lon: 10.14176 },  // 13.4 nm
  { id: '2c352538-ff14-459f-896c-fe713bc5d038', name: "Piastrone 1 M32", lat: 44.07622, lon: 10.15542 },  // 14.1 nm
  { id: '6643ac1a-03ac-40a9-885b-45aa36affd28', name: "Strettoia, Pietrasanta LU", lat: 43.98593, lon: 10.17988 },  // 16.6 nm
  { id: '25572417-1885-43d6-90f8-04457d41f070', name: "Querceta, Lucca/Davis Vantage Vue", lat: 43.97999, lon: 10.19335 },  // 17.2 nm
  { id: '9d87a88b-9b3f-4bda-937d-37d8e8cc0960', name: "Pontremoli nord (MS) - 267 m s.l.m.", lat: 44.38837, lon: 9.88537 },  // 17.5 nm
  { id: '45b0feb0-58c9-4bc6-900d-3f9c2a9bfbc7', name: "MeteoPonterosso - Pietrasanta", lat: 43.96769, lon: 10.21197 },  // 18.3 nm
  { id: '8784c16e-3324-46d9-9431-d4f97ad41575', name: "Meteo Varese Ligure", lat: 44.37645, lon: 9.59631 },  // 19.4 nm
  // San Juan Islands
  { id: 'e922a06c-08aa-4ec3-929a-12cccb1db6fc', name: "Lopez Shoal Bay", lat: 48.55501, lon: -122.88632 },  // 0.6 nm
  { id: '94f38ea0-0a6c-4e28-b9f6-430c14fa8365', name: "Lukas's weather station", lat: 48.54372, lon: -122.90136 },  // 1.2 nm
  { id: 'a8e1b101-d3ce-4e02-9993-1db0bc73c328', name: "37 Fish Bay", lat: 48.54224, lon: -122.8948 },  // 1.2 nm
  { id: '72c103c3-d61e-4020-a7b8-3d4aabdbe0ae', name: "Lopez Hayfield", lat: 48.54078, lon: -122.91196 },  // 1.5 nm
  { id: '652dbbd5-9668-4b50-bad3-6c1b62624601', name: "Blind Bay", lat: 48.58002, lon: -122.93109 },  // 1.8 nm
  { id: 'ffe92668-6e44-4fae-9e04-f17bff70a191', name: "WILDING FARM AIRPORT (6WA5)", lat: 48.57595, lon: -122.94105 },  // 2 nm
  { id: 'b7070942-008a-4bd1-9b34-e9e9ee95e29d', name: "Cayou Channel Orcas", lat: 48.59336, lon: -122.91954 },  // 2.1 nm
  { id: 'd7773f78-2b84-42b8-9bbb-12a7b72065c7', name: "Star View Farm - Lopez Island", lat: 48.52758, lon: -122.90781 },  // 2.2 nm
  { id: '0aa5b2d5-c515-4834-9522-7b6349e3ba2e', name: "Smugglers Cove on Blind Bay", lat: 48.58191, lon: -122.94263 },  // 2.2 nm
  { id: '0e6b0ec8-f4c8-413e-9ddc-eee94cf8ebe4', name: "SHANNON Weather Station", lat: 48.58585, lon: -122.96395 },  // 3.1 nm
  { id: 'ef8cc3d8-3658-4d89-a9fb-da5a5218e425', name: "Victorian Valley", lat: 48.6173, lon: -122.93733 },  // 3.7 nm
  { id: '27762c2e-2632-48d7-a466-144139e4bfce', name: "Fisherman’s Bay", lat: 48.50467, lon: -122.92872 },  // 3.7 nm
  { id: '414e091d-58a9-45ea-b202-7d9a0ed7af3c', name: "Orcas Deer Harbor", lat: 48.60134, lon: -122.98261 },  // 4.2 nm
  { id: '5d9f7fe2-6a45-420a-b39c-d938b8ec3a8e', name: "Pole Pass", lat: 48.60172, lon: -122.99038 },  // 4.5 nm
  { id: '687f05cb-0773-4732-a0a7-839f2efd73aa', name: "BrownIslandSouth", lat: 48.53559, lon: -123.0007 },  // 4.5 nm
  { id: '68b7fdbb-e1dc-47c0-8287-a63a1a4bf32e', name: "Friday Harbor Cove", lat: 48.5278, lon: -122.99662 },  // 4.6 nm
  { id: 'c0b1f757-b0b7-480d-a3e0-141e5a24b9da', name: "lopez island, wa", lat: 48.49229, lon: -122.9416 },  // 4.6 nm
  { id: 'b329f2f6-f079-4f6f-aaeb-31f6bc5f0af1', name: "Shipyard Cove, WA", lat: 48.52798, lon: -122.99915 },  // 4.6 nm
  { id: '5edeaeb3-0679-4fac-8c6f-65b08d7b5caa', name: "Hobbyloss Farms", lat: 48.63343, lon: -122.95779 },  // 4.9 nm
  { id: '26220a0b-f1a8-489d-95b5-66d58298d151', name: "Geiser Way", lat: 48.65186, lon: -122.8612 },  // 5.5 nm
  { id: '62bed30e-44cb-49cc-9e9e-1c16dd9dde92', name: "Hel's Heaven", lat: 48.47039, lon: -122.92253 },  // 5.6 nm
  { id: 'dbe7f238-fa64-4d33-a81b-e865b33ea34f', name: "Beaverton Valley", lat: 48.54012, lon: -123.04089 },  // 6 nm
  { id: 'a307d295-33bc-4f18-873a-2825f4329085', name: "Rebecca Poole", lat: 48.52621, lon: -123.0446 },  // 6.3 nm
  { id: '01d4ca37-5464-4948-a406-16f23f5b94bb', name: "Aigle Point", lat: 48.45921, lon: -122.93084 },  // 6.4 nm
  // Long Beach / San Pedro
  { id: 'ba606f7e-2253-4461-8c6c-20cb1744f9ee', name: "Cabrillo Dry Boat Storage", lat: 33.71749, lon: -118.27573 },  // 0.3 nm
  { id: 'e777661c-52c8-402b-8af8-a524f7959d98', name: "Larson Boat", lat: 33.7332, lon: -118.26819 },  // 0.8 nm
  { id: '6f779d14-a860-420d-bc55-6e6ce144b3e9', name: "Point Fermin", lat: 33.70757, lon: -118.29097 },  // 1.3 nm
  { id: 'b2ebfb12-1c6d-4206-a895-1b768792bc90', name: "Johns Home", lat: 33.71717, lon: -118.30963 },  // 2 nm
  { id: '731e8ca1-03cb-44a0-8feb-597503d4e498', name: "USBorax Gateway", lat: 33.75641, lon: -118.26643 },  // 2.2 nm
  { id: '92f2d5d1-958c-40ba-99d9-6f8bb2365b72', name: "Dodson Avenue/9th Street", lat: 33.7363, lon: -118.3114 },  // 2.3 nm
  { id: 'aa273154-36b4-46e8-aafc-5ebc55c81f17', name: "YTI Weather", lat: 33.75604, lon: -118.25354 },  // 2.3 nm
  { id: '7a0df903-3438-4d42-a18f-879c95209977', name: "SEPULVEDA ST", lat: 33.74536, lon: -118.30739 },  // 2.4 nm
  { id: '4f806231-1d86-47a3-b785-dcbb7165c8c5', name: "San Pedro, Anchovy/25th", lat: 33.72636, lon: -118.31989 },  // 2.5 nm
  { id: '0f374401-a570-406e-b289-12d393e0db8c', name: "SA Long Beach", lat: 33.75903, lon: -118.2207 },  // 3.4 nm
  { id: '12fe4185-2afd-41f6-8938-0d65a5be10cd', name: "Sunnyside Ridge", lat: 33.76404, lon: -118.31998 },  // 3.6 nm
  { id: '62ed6912-d402-4e1d-a1a2-e9a4b14a4baf', name: "Rockinghorse Rd, RPV, CA - Weather", lat: 33.75938, lon: -118.32645 },  // 3.7 nm
  { id: '87fdef8b-5eb3-4e97-b818-b97c8b7e8412', name: "Master Bath", lat: 33.7604, lon: -118.32601 },  // 3.7 nm
  { id: '153d8dbb-6ceb-4961-8a56-b36ee4031bc3', name: "MNR W Console 1", lat: 33.74846, lon: -118.20298 },  // 3.8 nm
  { id: 'dad25459-86cf-4cb9-8a47-db6b1171009f', name: "Lomita Home", lat: 33.77815, lon: -118.31564 },  // 4.2 nm
  { id: '2148e729-f806-4573-bad6-5435d48615f1', name: "S Lomita/RH Estates", lat: 33.77819, lon: -118.31569 },  // 4.2 nm
  { id: '0c150fa0-9bc6-4402-80a7-92310e269a2d', name: "LBA", lat: 33.75271, lon: -118.19081 },  // 4.4 nm
  { id: 'e64d8899-3578-4b1b-b466-581416209595', name: "Falcon", lat: 33.78399, lon: -118.22537 },  // 4.4 nm
  { id: '2d11d199-2b8b-4978-bec6-9713ab6100cc', name: "LB Shoreline Marina", lat: 33.75728, lon: -118.18816 },  // 4.7 nm
  { id: '55a3e790-c899-421c-bbd4-7a56bb549b9e', name: "Home", lat: 33.76902, lon: -118.1916 },  // 4.9 nm
  { id: 'e4ab2dd6-00f0-40b3-9320-df147a8eafa0', name: "Tigger's Crib", lat: 33.79254, lon: -118.32387 },  // 5.1 nm
  { id: '31269aba-5baf-4745-af71-41540e9af58d', name: "WA6MEM", lat: 33.7596, lon: -118.36676 },  // 5.4 nm
  { id: 'ebf37298-a1cb-483c-9649-c0ebffd05b0a', name: "27 West", lat: 33.74433, lon: -118.3858 },  // 6 nm
  { id: 'd0288a5e-35af-42d2-b13a-74da593f1363', name: "W5RN", lat: 33.7636, lon: -118.37999 },  // 6.1 nm
  // Ensenada
  { id: 'a7c0bad9-0902-4c6f-a67c-3a6909c6f0e8', name: "SEMAR E.I.O. ENSENADA", lat: 31.84782, lon: -116.61697 },  // 0.2 nm
  { id: 'e41366c7-e23c-4323-88ba-769d0426e92e', name: "[ICAARO] IIO-UABC, Ensenada", lat: 31.86259, lon: -116.66608 },  // 2.5 nm
  { id: '4cf32bf6-853c-4da5-925f-e73c87a4bffc', name: "LPM-DOF-CICESE", lat: 31.86936, lon: -116.66442 },  // 2.5 nm
  { id: 'ef200408-d4d0-4f87-a04a-04cdefe57a32', name: "08 ENSENADA / PROTECCIÓN CIVIL BC", lat: 31.80843, lon: -116.59198 },  // 2.9 nm
  { id: '0ebeb81d-9da8-4fb0-b7bc-9e04448eaba3', name: "Rancho Grande", lat: 32.07173, lon: -116.58882 },  // 13.4 nm
  { id: 'a70bfbea-375a-4601-b60e-f694260876fd', name: "Enología-UABC", lat: 32.07491, lon: -116.63454 },  // 13.5 nm
  { id: 'd2d918d7-ee2c-4aff-ba04-cd159a9e45f2', name: "Aire2", lat: 31.98156, lon: -116.83604 },  // 13.5 nm
  { id: '8afe9755-2ae3-4c65-bbae-9e0af511b57b', name: "ESTACIÓN GPE MX", lat: 32.0934, lon: -116.58681 },  // 14.7 nm
  { id: '806d0b1d-2e00-4d3b-828b-c17ffeb2bddd', name: "001D0A714A69", lat: 32.09716, lon: -116.61532 },  // 14.8 nm
  { id: 'd0141eea-fa7b-4259-9278-c67fa1e7572e', name: "VLACSA", lat: 32.11796, lon: -116.52011 },  // 16.9 nm
  { id: 'ec6a9e70-ce4f-4fdc-8542-570168c4cad0', name: "Alfalfa", lat: 32.1149, lon: -116.50792 },  // 16.9 nm
  { id: '7ce0f063-4222-4ba1-bf29-84b9d9d8d3cb', name: "ESTACION ON MX", lat: 31.9101, lon: -116.28891 },  // 17.2 nm
  { id: '2483935b-6899-4e76-bb4a-01ce469cfeca', name: "Viñedo Uva de Calidad RC", lat: 31.94773, lon: -116.29142 },  // 17.7 nm
  { id: '90e4ffa5-9133-4c1a-92e1-73f5996b0216', name: "obs 2 iplogger", lat: 31.44239, lon: -116.5284 },  // 24.9 nm
  // Viksfjord / Larvik
  { id: 'b15f275d-74b7-48e0-b12a-4a39d2efd0a4', name: "Lamøya", lat: 59.02793, lon: 10.10611 },  // 1.4 nm
  { id: '6a2f2510-fe15-48c0-9ae4-2b1fb770a0de', name: "Halsen", lat: 59.03765, lon: 10.06829 },  // 2.6 nm
  { id: '96e07ee6-f4f9-4c07-be36-69ee511e8c6c', name: "Vittersø", lat: 59.076, lon: 10.136 },  // 2.8 nm
  { id: 'c1c4d007-25c4-4e5f-923c-f6ee4b7e4fff', name: "Furutoppen", lat: 59.0085, lon: 10.03002 },  // 3.9 nm
  { id: 'c2beb5ff-3b54-4a1f-9daf-0ab494759aca', name: "Solstadløkka By Ronald", lat: 59.00601, lon: 10.02186 },  // 4.2 nm
  { id: '239cdd9c-f156-422b-a085-a6fe29486c62', name: "Foldvik Familiepark", lat: 59.0015, lon: 9.97251 },  // 5.7 nm
  { id: 'd0bc2b1c-473e-41a1-8dd0-0e7fe7b17f28', name: "Tjøme / Langvika", lat: 59.11737, lon: 10.3858 },  // 9 nm
  { id: '33540a5b-3da6-41ba-b75b-64c543d63a75', name: "Omlidstranda Camping", lat: 58.98436, lon: 9.84519 },  // 9.8 nm
  { id: '3383063f-c483-4532-af53-517ac62b2dbe', name: "Skipperstua", lat: 59.16422, lon: 10.38855 },  // 10.9 nm
  { id: 'e311fcf6-50ed-4219-8ee8-d156b1e9d7d8', name: "BraTer", lat: 59.00614, lon: 9.7418 },  // 12.7 nm
  { id: '9588e195-e8b9-4b0d-9c9f-c7a5a5f093f4', name: "Stathelle, Norway", lat: 59.04581, lon: 9.68332 },  // 14.4 nm
  { id: '1f2a3cac-6310-413f-a22e-55ad411afe5a', name: "Bjornhullet, Porsgrunn", lat: 59.13255, lon: 9.66077 },  // 16.3 nm
  { id: '7344ceb8-bc32-4a6c-835d-2d92cddaf31f', name: "ENSN", lat: 59.18441, lon: 9.57078 },  // 20.1 nm
  { id: 'a9f79722-53c1-4650-9bb9-7b603ee29aae', name: "Bærø OM", lat: 58.9, lon: 9.5 },  // 21.6 nm
  { id: '3618f711-7ec1-4c7a-a351-2f098fecf1ab', name: "Luin", lat: 58.82777, lon: 9.45954 },  // 24.6 nm
  // Fredrikstad / Sarpsborg
  { id: 'dd169c8d-ca0a-44fe-87da-af85b65f68c3', name: "Speiderfjellet", lat: 59.21371, lon: 10.94699 },  // 0.4 nm
  { id: '7fa14a77-b956-46c5-9669-3d3e01dccd7a', name: "Hannibalveien", lat: 59.21394, lon: 10.96113 },  // 0.5 nm
  { id: '8db391c8-e539-4fad-84f5-f53dd3a74a7c', name: "Høgskolen i Østfold", lat: 59.21326, lon: 10.92887 },  // 0.8 nm
  { id: '02317eae-0dd2-4f8c-9e83-3ae553147e21', name: "Sandvika, Kråkerøy", lat: 59.17475, lon: 10.90633 },  // 3 nm
  { id: '7441b026-d6f2-4864-882f-d87b00f2d102', name: "Holm Torsnes Fredrikstad", lat: 59.18463, lon: 11.06968 },  // 4.2 nm
  { id: '1b204f20-7d0c-4b2b-a76a-0ec187d0cd7f', name: "Gamle Kongevei, Grålum", lat: 59.29762, lon: 11.04297 },  // 5.5 nm
  { id: '1fad1a06-c3f6-418f-ad02-4a411e47f224', name: "Nordberg", lat: 59.26374, lon: 11.13472 },  // 6.2 nm
  { id: 'e3fe3244-c09b-4d5b-899e-4b1aa45bc0ee', name: "Marineshop Sarpsborg", lat: 59.28811, lon: 11.10537 },  // 6.3 nm
  { id: '5d7dda84-fa97-419a-b658-3008e9e6d1d3', name: "Vesterøy Været", lat: 59.10798, lon: 10.90742 },  // 6.8 nm
  { id: '71340e2e-3178-41c9-bbc0-378a914ebdbd', name: "Nøtsund", lat: 59.14689, lon: 11.13928 },  // 7.3 nm
  { id: '46b9ee82-8703-4871-bbd6-c860ab4c3b88', name: "Rade Batforening", lat: 59.30945, lon: 10.77962 },  // 7.5 nm
  { id: '6681a871-9dbf-42cf-a063-3d5d6d5f266f', name: "Fulehuk-Fyr", lat: 59.17503, lon: 10.59931 },  // 11.1 nm
  // Oslofjord / Horten
  { id: '235cc94b-bc00-4720-b5ef-0256fd056f5a', name: "Horten Seilforening", lat: 59.39793, lon: 10.48106 },  // 1.3 nm
  { id: 'eba23279-a798-4040-9aa7-a4a0d8a34da0', name: "Refsnesbakken", lat: 59.44293, lon: 10.62104 },  // 4.5 nm
  { id: '764d161a-1029-4e41-a8de-cd227703b6d3', name: "Kirkeparken VGS", lat: 59.43459, lon: 10.66305 },  // 5.7 nm
  { id: '188139f2-d5ac-492d-b2f8-eaa3619a0d66', name: "HSDA", lat: 59.48938, lon: 10.31844 },  // 6.4 nm
  { id: '03d341f2-3905-4bb6-a600-02b4b6ca8ba7', name: "Solgård Avfallsplass", lat: 59.44186, lon: 10.70759 },  // 7.1 nm
  { id: 'd82d59ee-e284-4ed7-b381-859ad3fb44fc', name: "Statkraft Tofte NY", lat: 59.54552, lon: 10.57489 },  // 8.1 nm
  { id: '873bf694-1ccd-438c-b6c2-3231615bc59e', name: "Eriksen Kilden Kino", lat: 59.27368, lon: 10.43613 },  // 8.9 nm
  { id: '1aa4833a-1e2c-4f51-918a-3765b744000c', name: "Sonskilen Båthavn", lat: 59.5258, lon: 10.68487 },  // 8.9 nm
  { id: 'fcdef574-0bb4-4311-b5e8-980025bdbb54', name: "Soon Golfbane Proshop", lat: 59.53345, lon: 10.68227 },  // 9.2 nm
  { id: 'c55c78d2-8efc-44c9-9742-804f117226c5', name: "Høyen weather", lat: 59.56865, lon: 10.39174 },  // 9.3 nm
  { id: '99407e01-2b72-4ec8-8a33-60759027cde7', name: "Marine Teknikk", lat: 59.55552, lon: 10.65479 },  // 9.7 nm
  { id: 'dbd2f563-e12f-4263-9921-20fa47c2f153', name: "Sole Skog Observatory", lat: 59.6, lon: 10.8 },  // 14.5 nm
  { id: '6c3d2356-a6a9-4aff-8abf-50c6e57c2b5d', name: "Sundet2", lat: 59.43738, lon: 10.0003 },  // 14.7 nm
  // Oslo
  { id: '25caa54d-238d-4f1d-8102-9918306cc825', name: "weatherlivelocal", lat: 59.91159, lon: 10.75876 },  // 1.1 nm
  { id: '2569dae1-11f2-4a9a-bc80-3dcc9f72d737', name: "Kolstadgata 24", lat: 59.91392, lon: 10.77415 },  // 1.6 nm
  { id: 'e129e354-c600-4985-bb64-a45293c44276', name: "Oslo - Bestum", lat: 59.92062, lon: 10.6699 },  // 2.2 nm
  { id: '002d79f3-635c-4b57-8a2d-2c7f62515aec', name: "Korallveien", lat: 59.86332, lon: 10.75709 },  // 2.3 nm
  { id: '7ae6633b-fa60-42ae-b54d-fb3dd5168b7b', name: "Teglverket skole", lat: 59.924, lon: 10.79513 },  // 2.4 nm
  { id: 'c5cf62e9-2845-4ea1-b527-6557eb32d217', name: "Refstad skole", lat: 59.93801, lon: 10.80618 },  // 3.2 nm
  { id: '80d14ef9-62a0-4144-be40-80d90ec579f0', name: "GriniGK", lat: 59.95064, lon: 10.6208 },  // 4.5 nm
  { id: 'd39519bb-d566-4a5d-a275-4de8a3aa4619', name: "Brattveien", lat: 59.91713, lon: 10.56813 },  // 5 nm
  { id: 'e33ae96c-c71b-426f-9734-74c4589d85c2', name: "Haga Golfklubb", lat: 59.94185, lon: 10.57952 },  // 5.2 nm
  { id: 'd7fc878f-52af-431d-978d-fa2f0dacf789', name: "LosbyGreenkeeper", lat: 59.89009, lon: 10.98415 },  // 7.7 nm
  { id: 'a76e5b4c-b70c-4c64-a8ad-abb9c375dff7', name: "Sørstien 13, Maridalen", lat: 60.0401, lon: 10.80824 },  // 8.7 nm
  { id: '99763774-391a-4de9-92d1-fe7227b0993c', name: "Jan F - Lommedalen Live", lat: 59.95915, lon: 10.46372 },  // 8.8 nm
  { id: '333deb2f-b9d8-492e-9723-4ea0291ffddd', name: "Omsi Gård", lat: 60.00638, lon: 10.95387 },  // 9.3 nm
  { id: '76b24567-2e07-4ff6-8865-a2b82b53f596', name: "Volla Lillestrøm", lat: 59.95836, lon: 11.03201 },  // 9.7 nm
  { id: '4a68910a-81af-44df-a134-a0f57557483a', name: "Kjeller Flyplass", lat: 59.96995, lon: 11.04072 },  // 10.2 nm
  { id: 'a58aa402-769e-44b1-b8b7-4371bf17c180', name: "Taeruddalen", lat: 60.01259, lon: 11.01914 },  // 11 nm
  { id: '581f842a-6215-4073-b09e-1c7dd694649b', name: "Nordby Rælingen", lat: 59.86406, lon: 11.09376 },  // 11.2 nm
  { id: '534761ab-543d-4537-b9b8-1c9017db140f', name: "Hallangspollen", lat: 59.70584, lon: 10.62464 },  // 12.1 nm
  { id: '88abee3d-6554-400d-8e4f-3f3c1197510d', name: "Skedsmokorset, Akershus", lat: 60.02724, lon: 11.04256 },  // 12.1 nm
  { id: '3c1309b5-b89d-4c68-bf50-1f364e3c9bd2', name: "Solihøgda", lat: 59.97091, lon: 10.34963 },  // 12.2 nm
  { id: '99cad726-1a8e-401d-8536-f8bc84d68d84', name: "LA2XNA", lat: 60.11431, lon: 10.83049 },  // 13.2 nm
  { id: '22dc5bc5-31de-4004-8394-cf117bdeba7d', name: "Tårnveien 25, Ås", lat: 59.67315, lon: 10.80391 },  // 13.8 nm
  { id: '23fe8282-36ce-4e67-8a40-b089fa3a2d43', name: "Tranby 365moh_2", lat: 59.82848, lon: 10.28666 },  // 14 nm
  { id: 'f1b049d7-8d86-46ab-8097-57e7b2049607', name: "devweather", lat: 59.66256, lon: 10.6417 },  // 14.5 nm
  { id: '9df61adb-3a90-46d6-8f42-34c475baea7d', name: "Solumstrand RA", lat: 59.7114, lon: 10.26878 },  // 17.9 nm
  // Sorrento
  { id: '20506aa6-faa6-44f2-866f-871c70952d7a', name: "Posillipo Denza - CNR ISMAR", lat: 40.80142, lon: 14.18594 },  // 6 nm
  { id: '3b64a0f6-31f8-40dc-86cd-651f07eac343', name: "Napoli Posillipo", lat: 40.80367, lon: 14.20054 },  // 6 nm
  { id: 'cf435a96-eb80-4705-aa10-e386f37110f7', name: "bagnolinautico", lat: 40.81405, lon: 14.16514 },  // 7 nm
  { id: '51c1d4f3-6c63-4f53-8fa1-b01757d505f3', name: "Napoli Meteo Chiaia Live", lat: 40.83621, lon: 14.23706 },  // 8 nm
  { id: '5e2bb9b3-6338-471b-b6b7-8d06df0ef22c', name: "In-marelab", lat: 40.83357, lon: 14.26801 },  // 8.1 nm
  { id: '7c575907-f4e4-4d64-97fa-ca1d786a5234', name: "DISTAR MSA Univ.Napoli", lat: 40.8379, lon: 14.18425 },  // 8.2 nm
  { id: '896848eb-2d84-4a7d-8167-7051b61b8666', name: "Napoli-Porto-CNR ISMAR", lat: 40.84429, lon: 14.25989 },  // 8.7 nm
  { id: '3267f0d5-d788-4872-bf08-204625c5c926', name: "Via Toledo Napoli", lat: 40.84664, lon: 14.24912 },  // 8.7 nm
  { id: '5e56e370-c65f-4f55-ba63-8186867b90c8', name: "Procida Istituto Nautico Caracciolo", lat: 40.76226, lon: 14.03095 },  // 9.1 nm
  { id: '9d451562-84bd-484c-870c-7978ea27fe31', name: "Napoli-Rione alto-Via Tropeano mt.298", lat: 40.86168, lon: 14.21901 },  // 9.5 nm
  { id: '927e3f90-1cb7-41c2-8b44-5e4508f9f513', name: "Vico Equense", lat: 40.66236, lon: 14.42538 },  // 9.9 nm
  { id: '6a276be8-676f-4969-9a6b-b86787b5a880', name: "PROCIDAMETEO", lat: 40.75847, lon: 14.00983 },  // 9.9 nm
  { id: 'b4a0efde-d74b-4a64-ab1e-ac5ee9e57e7d', name: "Colli di Fontanelle", lat: 40.6124, lon: 14.40477 },  // 10.2 nm
  { id: '477560e5-b245-4a15-a01a-799895a4ae3f', name: "Az. Ag. Don Andre’", lat: 40.82593, lon: 14.37925 },  // 10.4 nm
  { id: '1504bfac-4329-4045-95ae-b3cf63d47ba7', name: "San Sebastiano al Vesuvio - Liceo S. di Giacomo", lat: 40.83954, lon: 14.36674 },  // 10.6 nm
  { id: 'caa7ba5b-9193-45ae-8c28-b7a19ed447d7', name: "San Sebastiano", lat: 40.83867, lon: 14.38428 },  // 11.1 nm
  { id: '1f0e634c-c211-4e8e-a74f-8ded03acf482', name: "Marano via Norvegia 34", lat: 40.89754, lon: 14.1992 },  // 11.6 nm
  { id: '36112dec-3ca8-4591-850f-b66b280c2b1a', name: "Sito 17", lat: 40.72349, lon: 14.47492 },  // 11.9 nm
  { id: '4097a52a-16b3-4cae-9419-f5dbe5c1c7cf', name: "Sito 08", lat: 40.69633, lon: 14.48183 },  // 12.1 nm
  { id: 'd10102f7-d527-43ec-adc5-43f77a421e7e', name: "Stazione meteo Arenella", lat: 40.71639, lon: 13.94595 },  // 12.3 nm
  { id: 'f54e63e1-04e3-428a-8fab-7cc9e65cb348', name: "Cratere", lat: 40.82909, lon: 14.43048 },  // 12.3 nm
  { id: '0e22f842-58e8-4726-8f30-d96b3d40c806', name: "Monte Faito", lat: 40.66759, lon: 14.4842 },  // 12.4 nm
  { id: '522c6d58-e5dc-4cf9-90b0-87c8126a4905', name: "Polizia Municipale", lat: 40.70397, lon: 14.48884 },  // 12.4 nm
  { id: '0e8b1dab-1435-4eea-8324-6cb2626b087b', name: "Volla (NA) Liceo di Giacomo", lat: 40.88501, lon: 14.35091 },  // 12.5 nm
  { id: '383f6b0c-9356-4920-9fff-fe0f845a98ce', name: "Stazione meteo Casa Comunale di Ischia", lat: 40.74285, lon: 13.94176 },  // 12.7 nm
  { id: 'e4972b12-3cf1-441d-9537-26e1899b1349', name: "Pompei Bartolo Longo Osservatorio Meteorologico", lat: 40.74737, lon: 14.50132 },  // 13.3 nm
  { id: '9983c38a-4100-463b-b2dd-c88dcf5671da', name: "Malinconico", lat: 40.91462, lon: 14.10424 },  // 13.6 nm
  { id: '8efcf5b1-f16e-434d-9619-f30eb9ef3296', name: "San Nicola La Strada", lat: 40.86549, lon: 14.43765 },  // 14 nm
  { id: '5b15a9a8-8340-4fdb-82ea-17c2c2224bc8', name: "Grumo Nevano", lat: 40.93598, lon: 14.25844 },  // 14.1 nm
  { id: '77d6019b-7e9b-4941-8a09-d87b13607906', name: "Scafati", lat: 40.75155, lon: 14.52142 },  // 14.2 nm
  { id: '325bd760-760d-4c66-a8cf-8f5dc53bf5c5', name: "Ottaviano", lat: 40.84543, lon: 14.47178 },  // 14.4 nm
  { id: 'b9b6b31c-3521-473e-acca-25f9d70d3c43', name: "BOSCOREALE", lat: 40.78989, lon: 14.51504 },  // 14.6 nm
  { id: '3d88dfd2-c978-4c6f-bdd7-6d69192c5d38', name: "Pomigliano d'Arco Istituto Cantone", lat: 40.9106, lon: 14.39241 },  // 14.8 nm
  { id: '4e46d7b8-1f57-4895-b1fe-5c75238fae19', name: "Sant'Antonio Abate", lat: 40.71955, lon: 14.54106 },  // 14.8 nm
  { id: '01bc30e9-21c7-47c9-b0c6-797a5e208b17', name: "Centrale-ForioCB", lat: 40.74168, lon: 13.86817 },  // 16 nm
  { id: 'f4930d3a-dd97-4573-b28a-01326354aeb5', name: "IZ8GAD", lat: 40.97869, lon: 14.21173 },  // 16.5 nm
  { id: '44ffdc2d-44ba-4f40-b6ac-ce6c688dbd6b', name: "Lago Patria - CNR ISMAR - LegaAmbiente", lat: 40.94404, lon: 14.02969 },  // 16.7 nm
  { id: 'ea690579-64ce-405e-9a96-7d2f08dc14d6', name: "Corbara (SA)", lat: 40.72104, lon: 14.59297 },  // 17.2 nm
  { id: '052b60b0-9a42-4e4a-81b4-e2de8172c689', name: "Protezione Civile", lat: 41.00017, lon: 14.127 },  // 18.2 nm
  { id: '36b2e7e9-63b6-4127-9964-d505f5391028', name: "VUE", lat: 40.738, lon: 14.6414 },  // 19.5 nm
  { id: '8eb5134f-8e1e-43d1-8a62-c616f6a67e15', name: "Marcianise centro", lat: 41.0381, lon: 14.28482 },  // 20.3 nm
  { id: '3f67c354-eac8-49cb-91f0-6b99673d80a9', name: "CNR Foce Volturno - Licola", lat: 40.99386, lon: 13.96422 },  // 20.8 nm
  { id: '86c35d20-f3b2-4e7b-8a1a-d4a6c21da1ca', name: "Rescigno Vertical Farm", lat: 40.76492, lon: 14.67494 },  // 21.2 nm
  { id: 'bd4b41c5-9b9a-4fab-a091-af8f319dc374', name: "Stazione Meteo - Osservatorio Forino", lat: 40.96727, lon: 14.53833 },  // 21.5 nm
  { id: 'af568336-df19-4d32-9b9d-f53b07cb7149', name: "Parco Saurino", lat: 41.0734, lon: 14.22529 },  // 22.2 nm
  { id: 'fa6d10d6-47e3-4f39-ac49-a31b49e515c1', name: "CREA Caserta", lat: 41.07353, lon: 14.31731 },  // 22.7 nm
  { id: '193bc980-a2e1-4116-a138-771b9b6e67d2', name: "Forino (AV)", lat: 40.86383, lon: 14.73814 },  // 25.6 nm
  { id: 'eb0867bb-cce0-4d4c-a100-01fadde92d52', name: "Salerno Torrione Alto", lat: 40.6741, lon: 14.79062 },  // 26.2 nm
  { id: '34b994a8-e9cf-4b9b-939e-7cb883c06d37', name: "Salerno Arechi Porto", lat: 40.64391, lon: 14.81282 },  // 27.4 nm
  { id: 'b7bf1705-ad34-49a5-bd9d-ba6aa74b9a80', name: "Mercogliano", lat: 40.92564, lon: 14.7522 },  // 27.8 nm
  { id: '62fcfb50-485e-4ffd-870e-76690a3b3315', name: "Oasi di Frassineto (SA)", lat: 40.76126, lon: 14.83399 },  // 28.3 nm
  { id: 'b487f910-1763-421d-bbc1-23c667922e58', name: "PIGNATARO MAGGIORE (CE) - PROTEZIONE CIVILE", lat: 41.18307, lon: 14.16474 },  // 28.8 nm
  { id: '3ebab8e8-7c83-43f1-b5ae-edd138d81565', name: "Montesarchio S", lat: 41.06335, lon: 14.63777 },  // 28.8 nm
  { id: '12b04f45-14df-47a1-a069-8e80f659c9ca', name: "CautieroFrasso", lat: 41.1553, lon: 14.51365 },  // 30.3 nm
  { id: '16024b78-7879-45d5-84bb-5ae1c9b0c414', name: "Ecoambiente Sardone - Bit Line", lat: 40.65354, lon: 14.8794 },  // 30.4 nm
  { id: 'e311a385-eb33-47d9-8864-c90cc7d2e25c', name: "Cantina del Barone", lat: 40.89244, lon: 14.83774 },  // 30.4 nm
  { id: '031a6fdd-2165-45de-86c6-ebddafa67951', name: "Vigneti Malaguti Anfora", lat: 41.22041, lon: 13.99276 },  // 32.6 nm
  { id: '33ead087-e149-4560-9b7a-b2a1db9675eb', name: "Pietramelara", lat: 41.28875, lon: 14.19407 },  // 35.1 nm
  { id: '4f891c08-6bf7-4b28-a7c0-2b2a1ea0940d', name: "Benevento Pacevecchia mt. 230", lat: 41.11949, lon: 14.80025 },  // 36.4 nm
  { id: '5bb73b1f-9a95-49f0-a46f-dda9a093de8e', name: "_Vntlera_", lat: 41.24275, lon: 14.59594 },  // 36.6 nm
  { id: '2f78f34d-065a-4b97-bcf8-d87404100632', name: "TemplarePaestum", lat: 40.47137, lon: 14.9606 },  // 36.7 nm
  { id: '6c5f18d7-bef6-4722-be9e-dea32e520ebd', name: "AstroMax", lat: 41.26556, lon: 13.7445 },  // 39.9 nm
  { id: 'a96488cc-008f-49f4-877a-d87f0df5fed0', name: "Farm PetrosinoSabato", lat: 40.60381, lon: 15.08622 },  // 40.1 nm
  { id: 'fbb365c3-6b52-46fe-a441-a510a7692cec', name: "Mazzella - Pian Del Bosco", lat: 40.96772, lon: 15.02778 },  // 40.1 nm
  { id: '2ddb476f-067a-4190-9041-55b4ee02f7db', name: "GAETA LIDO SIRIO & UNINA", lat: 41.20959, lon: 13.56784 },  // 42.2 nm
  { id: '59559a83-7811-4c6f-81eb-ade363284ea9', name: "Danilo Formia", lat: 41.26765, lon: 13.61986 },  // 43.3 nm
  { id: '64ad8eda-6b58-4de7-9a89-86674d0f710c', name: "San Marco dei Cavoti (BN)", lat: 41.3, lon: 14.8 },  // 44.5 nm
  { id: '88dc8e44-1c46-40a4-81c4-679d250ec2f4', name: "Sepino", lat: 41.41229, lon: 14.6277 },  // 46.4 nm
  { id: '862be41c-8430-48aa-927b-7a5f5d8b5ba2', name: "San Vittore del Lazio", lat: 41.46122, lon: 13.93909 },  // 47.1 nm
  { id: '975a5ad3-ae52-4a86-a499-36591fc199dc', name: "IIS", lat: 41.15913, lon: 15.10838 },  // 48.8 nm
  // Porto Cervo
  { id: 'ea8fc38c-3af5-459b-8df7-e6d517c1306c', name: "Palau", lat: 41.16213, lon: 9.40185, seaNm: 1.5 },  // 6.4 nm
  { id: '62fe4657-b74d-47ea-b166-54c27a94de62', name: "Andre Porto Rotondo", lat: 41.02532, lon: 9.55092, seaNm: 1.5 },  // 6.6 nm
  { id: '6e09ed7e-d7c4-4fea-8c9b-dec29699ec08', name: "PORTO RAFAEL STATION", lat: 41.18192, lon: 9.38066, seaNm: 1.5 },  // 7.6 nm // known station, anemometer silent today
  { id: '5da3e544-6072-46e0-846d-c6cac2261b51', name: "Nautico La Maddalena", lat: 41.2189, lon: 9.40951, seaNm: 1.5 },  // 7.7 nm
  { id: 'b990eee0-befd-4ed2-9cb8-d0f7b68b4294', name: "Casagliana", lat: 40.99092, lon: 9.44917, seaNm: 5 },  // 9.5 nm
  { id: 'dad60b48-9c2a-4be4-88c8-6911aec9a873', name: "Olbia Meteo", lat: 40.92269, lon: 9.52219, seaNm: 1.5 },  // 12.8 nm
  { id: '03a9fe8b-e9d4-4e0f-90a1-f5ede1cfe2df', name: "Marina di Olbia", lat: 40.91614, lon: 9.5238, seaNm: 1.5 },  // 13.1 nm
  { id: '764adb9f-ea54-4bc9-9c36-5e1e036b11d0', name: "Olbia Tannaule", lat: 40.91449, lon: 9.48197, seaNm: 1.5 },  // 13.5 nm
  { id: '635e5578-de23-4768-a3dc-93d92ffc1155', name: "La Marina di Costa Corallina", lat: 40.88281, lon: 9.6266, seaNm: 1.5 },  // 15.7 nm
  { id: '462490f2-7858-4392-a9f2-2022f6d2858c', name: "Calangianus", lat: 40.92112, lon: 9.193, seaNm: 10 },  // 20.2 nm
  { id: 'be4f8f98-459d-421f-a843-a66d46ae945b', name: "Biasì Meteo", lat: 40.7757, lon: 9.55362, seaNm: 10 },  // 21.6 nm
  { id: '47bab906-585c-4e93-a2b0-6421c517f1fe', name: "Portobello di Gallura", lat: 41.12402, lon: 9.02719, seaNm: 1.5 },  // 23.1 nm
  { id: '49b40354-4bc0-4da9-b9db-8b9605b4df78', name: "Limbara Vallicciola", lat: 40.8488, lon: 9.15322, seaNm: 10 },  // 24.5 nm
  { id: '5510a4e9-9360-4e2b-a011-a000f1e7c563', name: "Figari", lat: 41.5111, lon: 9.14928, seaNm: 10 },  // 28.6 nm
  { id: '0ce58969-c7ff-41f4-93e4-ababf1836660', name: "ISS MARIA DE PERETTI", lat: 41.57766, lon: 9.26692, seaNm: 1.5 },  // 29.2 nm
  { id: 'c356050e-fcc0-413e-a266-7d821d723d85', name: "Pedra Bianca", lat: 40.63553, lon: 9.53408, seaNm: 10 },  // 30 nm
  { id: '4fad1ca8-d694-4280-beec-c8851653a7c2', name: "Osidda", lat: 40.52596, lon: 9.23217, seaNm: 10 },  // 39.1 nm
  { id: '0147141a-b5bf-479c-a8fa-4fd3ecd4e664', name: "Bitti", lat: 40.47753, lon: 9.38295, seaNm: 10 },  // 40.1 nm
  { id: 'ec34fa2c-6867-4aa2-b89c-03380c81ed30', name: "CS SNSM PROPRIANO", lat: 41.6774, lon: 8.89749, seaNm: 1.5 },  // 43.5 nm
  { id: '94863340-05d2-48fc-b2f1-a6d6f7ed80ef', name: "Osilo", lat: 40.74379, lon: 8.67096, seaNm: 10 },  // 45.8 nm
]
