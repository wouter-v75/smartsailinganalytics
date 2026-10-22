// Public Davis stations near our venues, from weatherlink.com's own map.
//
// GENERATED, not hand-found — scripts/davis-map-refresh.ts rebuilds it. The
// index behind weatherlink.com/map lists 79,522 public stations worldwide with
// their positions; this is the nearest six to each venue that were LIVE when
// the list was built.
//
// WHY A FILE AND NOT A LOOKUP. That index is 8.4 MB. Fetching it every quarter
// of an hour would be 0.8 GB a day off their server for data that changes when
// somebody installs an anemometer — and it is over Next's 2 MB fetch-cache
// limit, so it would genuinely refetch every time. Station positions are stable;
// the readings are not, and only the readings are polled.
//
// EVERY ENTRY WAS CHECKED, and five of the forty-eight candidates were dropped:
//   LER and LPM-DOF-CICESE at Ensenada, last reporting 47 and 45 hours before.
//   Beauvallon at St Tropez, 56 hours.
//   Portorotondo at Porto Cervo, 9 hours.
//   "Home" near Ensenada, which publishes no wind at all.
// Listed unchecked they would have been silent absences with nothing to say
// which — the same three-in-nine rate as the Solent club feeds.
//
// These are private stations their owners chose to publish: gardens, marinas,
// boatyards, a yacht club. They draw as `pws`, the lowest trust, because a good
// instrument in an unknown garden is exactly what that tier is for. Where one
// of them IS a curated embed (Gurnard appears in both, under different ids),
// dropDuplicatesOf removes it by position.
//
// Built 22 Oct 2026.

import type { WlMapStation } from './windObs'

export interface DavisMapStation extends WlMapStation { name: string }

export const DAVIS_MAP_STATIONS: DavisMapStation[] = [
  // Solent / Cowes
  { id: '1d4ad0be-d14d-48fc-b96f-a2de82322d9d', name: "Sollars Marine Surveys", lat: 50.75862, lon: -1.30611 },  // 0.8 nm
  { id: 'd419c2cb-b56f-4de0-ad13-8f95cba9f6a0', name: "Lammas Lodge", lat: 50.76317, lon: -1.31524 },  // 1 nm
  { id: '97e86222-100e-4f42-a8b8-5b45bc074ecd', name: "Cowes", lat: 50.76317, lon: -1.31532 },  // 1.1 nm
  { id: 'ba239a3d-ac84-4781-b9bb-ec469549c4be', name: "GurnardSC", lat: 50.76036, lon: -1.32505 },  // 1.4 nm
  { id: '4b09f590-865c-4dcc-9f18-4f41be3c0bbe', name: "Alf HCG", lat: 50.74104, lon: -1.31442 },  // 1.8 nm
  { id: '55172bb1-ec6e-4769-808c-773ca7c35991', name: "@West Medina", lat: 50.72383, lon: -1.28469 },  // 2.5 nm
  // Lymington
  { id: 'ceb5a199-3107-4a25-adf3-bae466750afc', name: "Sway road, Lymington", lat: 50.76973, lon: -1.55644 },  // 2.4 nm
  { id: '5a2cfc3d-d04d-4b94-a734-40d77544800a', name: "Downtonweather", lat: 50.74076, lon: -1.61192 },  // 3 nm
  { id: 'b0072b5a-8ffd-4cca-8ee7-f7338cd9be9e', name: "The Coach House", lat: 50.74317, lon: -1.62919 },  // 3.7 nm
  { id: '74f82abc-1a92-41a8-bd23-b144d9b57b36', name: "Newlands Farm", lat: 50.78828, lon: -1.46228 },  // 4.3 nm
  { id: '66aef694-22b9-431e-bbdf-e433c5460c3b', name: "treehouse", lat: 50.74386, lon: -1.65857 },  // 4.8 nm
  { id: '102b5e09-6e84-4d62-b061-22fa5ae16834', name: "Rhinefield Close", lat: 50.82142, lon: -1.58406 },  // 5.6 nm
  // St Tropez
  { id: '92e78f95-aa6a-407b-969f-c35224e68fad', name: "Yacht Club de Saint-Tropez", lat: 43.26634, lon: 6.66815 },  // 0.7 nm
  { id: '60a4f639-ad11-47e4-9d38-303add35d94a', name: "GASSIN", lat: 43.25866, lon: 6.57056 },  // 4.8 nm
  { id: 'ac22feda-189b-484a-b661-d8dc33ec80d9', name: "VallonVert", lat: 43.30928, lon: 6.5519 },  // 5.9 nm
  { id: '7782a0b2-1300-4ffd-b35f-07a7c9755a10', name: "Tadasana", lat: 43.35522, lon: 6.5508 },  // 7.4 nm
  { id: '5fb52b1e-3f27-4ee0-b53c-c8393a1d6d00', name: "Maison des Chiens", lat: 43.34059, lon: 6.53362 },  // 7.4 nm
  // Porto Cervo
  { id: 'ea8fc38c-3af5-459b-8df7-e6d517c1306c', name: "Palau", lat: 41.16213, lon: 9.40185 },  // 6.4 nm
  { id: '62fe4657-b74d-47ea-b166-54c27a94de62', name: "Andre Porto Rotondo", lat: 41.02532, lon: 9.55092 },  // 6.6 nm
  { id: '6e09ed7e-d7c4-4fea-8c9b-dec29699ec08', name: "PORTO RAFAEL STATION", lat: 41.18192, lon: 9.38066 },  // 7.6 nm
  { id: '5da3e544-6072-46e0-846d-c6cac2261b51', name: "Nautico La Maddalena", lat: 41.2189, lon: 9.40951 },  // 7.7 nm
  { id: 'b990eee0-befd-4ed2-9cb8-d0f7b68b4294', name: "Casagliana", lat: 40.99092, lon: 9.44917 },  // 9.5 nm
  // La Spezia
  { id: '28ad6c9c-4287-49cc-8444-31b729d8d9cc', name: "Porticciolo Diportisti Morin", lat: 44.10265, lon: 9.82567 },  // 0.2 nm
  { id: 'c0103a5f-a02f-4c81-904c-f06fc0c58ece', name: "GRAVEGLIA", lat: 44.15472, lon: 9.78226 },  // 3.9 nm
  { id: '8aa03c52-99c2-42f9-ae62-9c1cc77d4efe', name: "Deposito di Arcola", lat: 44.1214, lon: 9.91852 },  // 4 nm
  { id: '33c5cc27-db46-486b-a300-0a58b1f225a7', name: "SSM-WS02", lat: 44.14838, lon: 9.91228 },  // 4.6 nm
  { id: '185a7c34-0ae7-4c7e-aefa-144cbfed7517', name: "SSM-WS01", lat: 44.14931, lon: 9.91386 },  // 4.7 nm
  { id: '431798c4-eb25-4e0f-916e-d4fb0c62c5f6', name: "SARZANA - SANTA CATERINA", lat: 44.12083, lon: 9.95312 },  // 5.5 nm
  // San Juan Islands
  { id: 'e922a06c-08aa-4ec3-929a-12cccb1db6fc', name: "Lopez Shoal Bay", lat: 48.55501, lon: -122.88632 },  // 0.6 nm
  { id: '94f38ea0-0a6c-4e28-b9f6-430c14fa8365', name: "Lukas's weather station", lat: 48.54372, lon: -122.90136 },  // 1.2 nm
  { id: 'a8e1b101-d3ce-4e02-9993-1db0bc73c328', name: "37 Fish Bay", lat: 48.54224, lon: -122.8948 },  // 1.2 nm
  { id: '72c103c3-d61e-4020-a7b8-3d4aabdbe0ae', name: "Lopez Hayfield", lat: 48.54078, lon: -122.91196 },  // 1.5 nm
  { id: '652dbbd5-9668-4b50-bad3-6c1b62624601', name: "Blind Bay", lat: 48.58002, lon: -122.93109 },  // 1.8 nm
  { id: 'ffe92668-6e44-4fae-9e04-f17bff70a191', name: "WILDING FARM AIRPORT (6WA5)", lat: 48.57595, lon: -122.94105 },  // 2 nm
  // Long Beach / San Pedro
  { id: 'ba606f7e-2253-4461-8c6c-20cb1744f9ee', name: "Cabrillo Dry Boat Storage", lat: 33.71749, lon: -118.27573 },  // 0.3 nm
  { id: 'e777661c-52c8-402b-8af8-a524f7959d98', name: "Larson Boat", lat: 33.7332, lon: -118.26819 },  // 0.8 nm
  { id: '6f779d14-a860-420d-bc55-6e6ce144b3e9', name: "Point Fermin", lat: 33.70757, lon: -118.29097 },  // 1.3 nm
  { id: 'b2ebfb12-1c6d-4206-a895-1b768792bc90', name: "Johns Home", lat: 33.71717, lon: -118.30963 },  // 2 nm
  { id: '731e8ca1-03cb-44a0-8feb-597503d4e498', name: "USBorax Gateway", lat: 33.75641, lon: -118.26643 },  // 2.2 nm
  { id: '92f2d5d1-958c-40ba-99d9-6f8bb2365b72', name: "Dodson Avenue/9th Street", lat: 33.7363, lon: -118.3114 },  // 2.3 nm
  // Ensenada — the venue that had nothing inside 50 nm this morning
  { id: 'a7c0bad9-0902-4c6f-a67c-3a6909c6f0e8', name: "SEMAR E.I.O. ENSENADA", lat: 31.84782, lon: -116.61697 },  // 0.2 nm
  { id: 'e41366c7-e23c-4323-88ba-769d0426e92e', name: "[ICAARO] IIO-UABC, Ensenada", lat: 31.86259, lon: -116.66608 },  // 2.5 nm
  { id: 'ef200408-d4d0-4f87-a04a-04cdefe57a32', name: "08 ENSENADA / PROTECCIÓN CIVIL BC", lat: 31.80843, lon: -116.59198 },  // 2.9 nm
  // Viksfjord / Larvik — Norway. All six verified live 22 Oct 2026; nothing
  // else reaches here, since NDBC is American and Météo-France is French, and
  // the nearest METAR (ENTO, Torp) is an inland airport 9.8 nm away.
  { id: 'b15f275d-74b7-48e0-b12a-4a39d2efd0a4', name: "Lamøya", lat: 59.02793, lon: 10.10611 },  // 1.4 nm
  { id: '6a2f2510-fe15-48c0-9ae4-2b1fb770a0de', name: "Halsen", lat: 59.03765, lon: 10.06829 },  // 2.6 nm
  { id: '96e07ee6-f4f9-4c07-be36-69ee511e8c6c', name: "Vittersø", lat: 59.076, lon: 10.136 },  // 2.8 nm
  { id: 'c1c4d007-25c4-4e5f-923c-f6ee4b7e4fff', name: "Furutoppen", lat: 59.0085, lon: 10.03002 },  // 3.9 nm
  { id: 'c2beb5ff-3b54-4a1f-9daf-0ab494759aca', name: "Solstadløkka", lat: 59.00601, lon: 10.02186 },  // 4.2 nm
  { id: '239cdd9c-f156-422b-a085-a6fe29486c62', name: "Foldvik Familiepark", lat: 59.0015, lon: 9.97251 },  // 5.7 nm
  // Across the fjord mouth, so a different exposure on a sea breeze.
  { id: 'd0bc2b1c-473e-41a1-8dd0-0e7fe7b17f28', name: "Tjøme / Langvika", lat: 59.11737, lon: 10.3858 },  // 9.0 nm
  // Oslofjord / Horten
  { id: '235cc94b-bc00-4720-b5ef-0256fd056f5a', name: "Horten Seilforening", lat: 59.39793, lon: 10.48106 },  // 1.3 nm
  { id: 'eba23279-a798-4040-9aa7-a4a0d8a34da0', name: "Refsnesbakken", lat: 59.44293, lon: 10.62104 },  // 4.5 nm
  { id: '764d161a-1029-4e41-a8de-cd227703b6d3', name: "Kirkeparken VGS", lat: 59.43459, lon: 10.66305 },  // 5.7 nm
  { id: '188139f2-d5ac-492d-b2f8-eaa3619a0d66', name: "HSDA", lat: 59.48938, lon: 10.31844 },  // 6.5 nm
  { id: '03d341f2-3905-4bb6-a600-02b4b6ca8ba7', name: "Solgård Avfallsplass", lat: 59.44186, lon: 10.70759 },  // 7.1 nm
  { id: 'd82d59ee-e284-4ed7-b381-859ad3fb44fc', name: "Statkraft Tofte NY", lat: 59.54552, lon: 10.57489 },  // 8.1 nm
  // Oslo
  { id: '25caa54d-238d-4f1d-8102-9918306cc825', name: "weatherlivelocal", lat: 59.91159, lon: 10.75876 },  // 1.1 nm
  { id: '2569dae1-11f2-4a9a-bc80-3dcc9f72d737', name: "Kolstadgata 24", lat: 59.91392, lon: 10.77415 },  // 1.6 nm
  { id: 'e129e354-c600-4985-bb64-a45293c44276', name: "Oslo - Bestum", lat: 59.92062, lon: 10.6699 },  // 2.2 nm
  { id: '002d79f3-635c-4b57-8a2d-2c7f62515aec', name: "Korallveien", lat: 59.86332, lon: 10.75709 },  // 2.3 nm
  { id: '7ae6633b-fa60-42ae-b54d-fb3dd5168b7b', name: "Teglverket skole", lat: 59.924, lon: 10.79513 },  // 2.4 nm
  { id: 'c5cf62e9-2845-4ea1-b527-6557eb32d217', name: "Refstad skole", lat: 59.93801, lon: 10.80618 },  // 3.2 nm
  // Fredrikstad / Sarpsborg
  { id: 'dd169c8d-ca0a-44fe-87da-af85b65f68c3', name: "Speiderfjellet", lat: 59.21371, lon: 10.94699 },  // 0.4 nm
  { id: '7fa14a77-b956-46c5-9669-3d3e01dccd7a', name: "Hannibalveien", lat: 59.21394, lon: 10.96113 },  // 0.5 nm
  { id: '8db391c8-e539-4fad-84f5-f53dd3a74a7c', name: "Høgskolen i Østfold", lat: 59.21326, lon: 10.92887 },  // 0.8 nm
  { id: '02317eae-0dd2-4f8c-9e83-3ae553147e21', name: "Sandvika, Kråkerøy", lat: 59.17475, lon: 10.90633 },  // 3 nm
  { id: '7441b026-d6f2-4864-882f-d87b00f2d102', name: "Holm Torsnes Fredrikstad", lat: 59.18463, lon: 11.06968 },  // 4.2 nm
  { id: '1b204f20-7d0c-4b2b-a76a-0ec187d0cd7f', name: "Gamle Kongevei, Grålum", lat: 59.29762, lon: 11.04297 },  // 5.5 nm
]
