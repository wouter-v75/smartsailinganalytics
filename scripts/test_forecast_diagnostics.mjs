// Node test for forecastDiagnostics.js (build step 1-2: primitives + stability).
// Run: node scripts/test_forecast_diagnostics.mjs
import {
  signedAngle, angularDiff, circMean, circStd, std,
  coastNormalFromMask, coastNormal, VENUE_COAST_NORMAL,
  crossShoreComponent, thermalBend, seaBreezeIndex, modelSpread,
  ensureHeights, stabilityFromSounding, stabilityGate, specificHumidity,
  quadrantModifier, seaBreezeScore, isFavourable, typeOfDay, cloudTrend, confidence,
  windUV, funnelDiagnostics, funnelFlag,
} from '../src/components/weather/forecastDiagnostics.js'

let pass = 0; let fail = 0
const approx = (a, b, tol = 1e-6) => a != null && b != null && Math.abs(a - b) <= tol
function ok(name, cond, got) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}  got=${JSON.stringify(got)}`) }
}

console.log('angles')
ok('signedAngle 350,10 = -20', approx(signedAngle(350, 10), -20), signedAngle(350, 10))
ok('signedAngle 10,350 = +20', approx(signedAngle(10, 350), 20), signedAngle(10, 350))
ok('angularDiff 350,10 = 20', approx(angularDiff(350, 10), 20), angularDiff(350, 10))
ok('circMean [350,10,0] ≈ 0', approx(((circMean([350, 10, 0]) + 180) % 360) - 180, 0, 1e-6), circMean([350, 10, 0]))
ok('circStd identical = 0', approx(circStd([90, 90, 90]), 0), circStd([90, 90, 90]))
ok('circStd spread >0', circStd([0, 90, 180, 270]) > 40, circStd([0, 90, 180, 270]))
ok('std [10,12,14] ≈ 1.633', approx(std([10, 12, 14]), Math.sqrt((4 + 0 + 4) / 3), 1e-9), std([10, 12, 14]))

console.log('coast normal from mask')
// Synthetic coast: land (1) on the EAST (right, high j), sea (0) on the WEST.
// outward normal (land→sea) should point WEST = 270°.
const N = 11
const maskWestSea = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => (j >= 5 ? 1 : 0)))
ok('west-sea coast → ~270°', approx(coastNormalFromMask(maskWestSea, 5, 5, { radius: 2 }), 270, 1), coastNormalFromMask(maskWestSea, 5, 5, { radius: 2 }))
// Land to the SOUTH (low i, northUp), sea to the NORTH → normal points NORTH = 0/360.
const maskSouthLand = Array.from({ length: N }, (_, i) => Array.from({ length: N }, () => (i < 5 ? 1 : 0)))
const cnN = coastNormalFromMask(maskSouthLand, 5, 5, { radius: 2 })
ok('south-land coast → ~0/360°', approx(((cnN + 180) % 360) - 180, 0, 1) || approx(cnN, 360, 1), cnN)
ok('override beats mask', coastNormal('la_spezia', { mask: maskWestSea, i0: 5, j0: 5 }).source === 'override', coastNormal('la_spezia', {}))
ok('override value = table', coastNormal('la_spezia').deg === VENUE_COAST_NORMAL.la_spezia, coastNormal('la_spezia').deg)

console.log('cross-shore component (θ=270, sea to west)')
const TH = 270
ok('wind FROM east (90) is offshore (+)', crossShoreComponent(90, 10, TH) > 9.9, crossShoreComponent(90, 10, TH))
ok('wind FROM west (270) is onshore (-)', crossShoreComponent(270, 10, TH) < -9.9, crossShoreComponent(270, 10, TH))
ok('wind FROM south (180) ≈ along-shore (~0)', approx(crossShoreComponent(180, 10, TH), 0, 1e-6), crossShoreComponent(180, 10, TH))

console.log('thermal bend')
ok('surface 200 vs gradient 180 = +20 (veered right)', approx(thermalBend(200, 180), 20), thermalBend(200, 180))
ok('surface 170 vs gradient 200 = -30 (backed left)', approx(thermalBend(170, 200), -30), thermalBend(170, 200))

console.log('sea-breeze index (θ=270, sea to west)')
// Classic pure sea breeze: surface onshore = FROM the west (270); BL-top offshore = FROM the east (90).
ok('onshore surf + offshore aloft → SBI≈1', approx(seaBreezeIndex(270, 90, TH), 1, 1e-6), seaBreezeIndex(270, 90, TH))
// Gradient day: surface & aloft both offshore (FROM east) → no cell → SBI 0.
ok('both offshore → SBI 0', approx(seaBreezeIndex(90, 90, TH), 0, 1e-6), seaBreezeIndex(90, 90, TH))
// Surface onshore but aloft also onshore → SBI 0.
ok('surf onshore, aloft onshore → SBI 0', approx(seaBreezeIndex(270, 270, TH), 0, 1e-6), seaBreezeIndex(270, 270, TH))

console.log('model spread')
const ms = modelSpread([180, 185, 175, 190], [12, 13, 11, 14])
ok('σ_TWD small for tight dirs (<10°)', ms.sigmaTwd < 10, ms.sigmaTwd)
ok('σ_TWS ≈ std', approx(ms.sigmaTws, std([12, 13, 11, 14]), 1e-9), ms.sigmaTws)
const ms2 = modelSpread([0, 90, 180, 270], [5, 20, 8, 15])
ok('σ_TWD large for scattered dirs (>40°)', ms2.sigmaTwd > 40, ms2.sigmaTwd)

console.log('hypsometric heights')
// ~1000→900 hPa at ~15°C should be ~ 800-900 m thickness.
const hp = ensureHeights([{ press: 1000, tempC: 15 }, { press: 900, tempC: 9 }])
ok('1000→900 hPa thickness ~780-950 m', hp[1].z > 780 && hp[1].z < 950, hp[1].z)
ok('surface z = 0', hp[0].z === 0, hp[0].z)

console.log('stability from sounding')
// Case A — well-mixed, deep, NO low cap: near-dry-adiabatic to 1500 m.
const wellMixed = [
  { press: 1010, tempC: 22 }, { press: 950, tempC: 16.5 }, { press: 900, tempC: 12 },
  { press: 850, tempC: 7.5 }, { press: 800, tempC: 3 },
]
const sA = stabilityFromSounding(wellMixed)
ok('well-mixed: no low cap', sA.hasLowCap === false, sA)
ok('well-mixed: near-dry-adiabatic', sA.nearDryAdiabatic === true, sA.lapseRateCkm)
ok('well-mixed: lapse ~9-10 °C/km', sA.lapseRateCkm > 8 && sA.lapseRateCkm < 11, sA.lapseRateCkm)
// Case B — LOW strong capping inversion ~ a few hundred m: temp rises sharply low down.
const cappedLow = [
  { press: 1010, tempC: 20 }, { press: 990, tempC: 18.5 }, // ~150 m
  { press: 975, tempC: 21 },  // inversion: +2.5°C rise just above ~300 m
  { press: 950, tempC: 20.5 }, { press: 900, tempC: 16 },
]
const sB = stabilityFromSounding(cappedLow)
ok('low cap: detected', sB.hasLowCap === true, sB)
ok('low cap: base < 800 m', sB.capBaseM != null && sB.capBaseM < 800, sB.capBaseM)
ok('low cap: strength ≥1 °C', (sB.capStrengthC ?? 0) >= 1, sB.capStrengthC)
// Case C — strong inversion but HIGH (well above a deep CBL) → not a low cap.
const cappedHigh = [
  { press: 1010, tempC: 24 }, { press: 900, tempC: 14 }, { press: 850, tempC: 9.5 },
  { press: 820, tempC: 12 }, // inversion up near ~1700 m
  { press: 780, tempC: 11 },
]
const sC = stabilityFromSounding(cappedHigh)
ok('high cap: NOT flagged as low cap', sC.hasLowCap === false, sC)
ok('high cap: cap base > 800 m', sC.capBaseM == null || sC.capBaseM > 800, sC.capBaseM)

console.log('stability gate')
const gWell = stabilityGate({ hMix: 1300, ...sA })
const gCapped = stabilityGate({ hMix: 350, ...sB })
ok('gate high for deep well-mixed (>0.8)', gWell > 0.8, gWell)
ok('gate low for shallow low-capped (<0.3)', gCapped < 0.3, gCapped)
ok('gate monotone (well > capped)', gWell > gCapped, [gWell, gCapped])

console.log('specific humidity sanity')
ok('q(20°C,50%,1000hPa) ~0.0073', approx(specificHumidity(20, 50, 1000), 0.0073, 0.001), specificHumidity(20, 50, 1000))

console.log('quadrant modifier (θ=270, sea to west, NH)')
const qLightOff = quadrantModifier(270, 90, 6)    // FROM east → straight offshore, light
ok('light offshore → +ve mod', qLightOff.scoreMod > 0, qLightOff)
const qStrongOff = quadrantModifier(270, 90, 22)  // straight offshore, strong
ok('strong offshore → -ve mod (suppress)', qStrongOff.scoreMod < 0, qStrongOff)
const qOnshore = quadrantModifier(270, 270, 10)   // FROM west → onshore
ok('onshore → Q2 reinforcement (+ve)', qOnshore.quadrant === 'Q2' && qOnshore.scoreMod > 0, qOnshore)
// along-shore: gradient blowing toward south (180) — land-on-left (NH) vs right
const qAlongA = quadrantModifier(270, 0, 12)      // FROM north → toward south
const qAlongB = quadrantModifier(270, 180, 12)    // FROM south → toward north
ok('along-shore both classified along (Q4 or Q3)', ['Q4', 'Q3'].includes(qAlongA.quadrant) && ['Q4', 'Q3'].includes(qAlongB.quadrant), [qAlongA.quadrant, qAlongB.quadrant])
ok('along-shore favourable side scores higher', Math.max(qAlongA.scoreMod, qAlongB.scoreMod) > Math.min(qAlongA.scoreMod, qAlongB.scoreMod), [qAlongA.scoreMod, qAlongB.scoreMod])
ok('onset breeze FROM the sea (θ=270)', qOnshore.dirOnsetFrom === 270, qOnshore.dirOnsetFrom)
ok('peak veers right (NH) to ~305', qOnshore.dirPeakFrom === 305, qOnshore.dirPeakFrom)

console.log('sea-breeze score')
const scGood = seaBreezeScore({ gStab: 0.9, gSolar: 0.95, offshoreKt: 4, deltaT: 5, lapseRateCkm: 9, hMix: 1300, quadMod: 2 })
const scKilled = seaBreezeScore({ gStab: 0.1, gSolar: 0.9, offshoreKt: 4, deltaT: 5, lapseRateCkm: 9, hMix: 350, quadMod: 2 })
const scStrongGrad = seaBreezeScore({ gStab: 0.9, gSolar: 0.95, offshoreKt: 20, deltaT: 1, lapseRateCkm: 9, hMix: 1300, quadMod: -2 })
ok('favourable day scores high (>6)', scGood.score > 6, scGood)
ok('stability gate kills score (<3)', scKilled.score < 3, scKilled)
ok('strong gradient day scores low (<4)', scStrongGrad.score < 4, scStrongGrad)
ok('good > killed', scGood.score > scKilled.score, [scGood.score, scKilled.score])

console.log('isFavourable')
ok('healthy gate + cell = favourable', isFavourable({ gStab: 0.8, sbi: 0.4 }) === true, true)
ok('dead gate = not favourable', isFavourable({ gStab: 0.2, sbi: 0.4 }) === false, false)

console.log('type-of-day (4 classes)')
ok('funnel flag → funnelled', typeOfDay({ funnelFlag: true, lowLevelKt: 14 }).cls === 'funnelled', true)
ok('<10kn + favourable → pure sea breeze', typeOfDay({ lowLevelKt: 7, favourable: true, sbi: 0.5 }).cls === 'pure_seabreeze', true)
ok('<10kn + unfavourable → gradient_light', typeOfDay({ lowLevelKt: 7, favourable: false }).cls === 'gradient_light', true)
ok('>10kn + favourable + bend → thermally_enhanced', typeOfDay({ lowLevelKt: 14, favourable: true, sbi: 0.3 }).cls === 'thermally_enhanced', true)
ok('>10kn + LOW sbi but strong bend → thermally_enhanced (reinforced)', typeOfDay({ lowLevelKt: 14, favourable: true, sbi: 0.02, thermalBendDeg: 28 }).cls === 'thermally_enhanced', typeOfDay({ lowLevelKt: 14, favourable: true, sbi: 0.02, thermalBendDeg: 28 }))
ok('>10kn + favourable quadrant only → thermally_enhanced', typeOfDay({ lowLevelKt: 13, favourable: true, quadFav: true, sbi: 0 }).cls === 'thermally_enhanced', true)
ok('>10kn + unfavourable → gradient', typeOfDay({ lowLevelKt: 16, favourable: false, thermalBendDeg: 8 }).cls === 'gradient', true)
ok('>10kn + gate ok but no thermal signal → gradient', typeOfDay({ lowLevelKt: 16, favourable: true, sbi: 0.01, thermalBendDeg: 6 }).cls === 'gradient', typeOfDay({ lowLevelKt: 16, favourable: true, sbi: 0.01, thermalBendDeg: 6 }))

console.log('cloud trend')
ok('clear AM → favourable +ve', cloudTrend({ landCloudAm: 1, landCloudMid: 1 }).signal > 0.5, cloudTrend({ landCloudAm: 1 }))
ok('overcast → suppressed -ve', cloudTrend({ landCloudAm: 7, landCloudMid: 7 }).verdict === 'suppressed', cloudTrend({ landCloudAm: 7 }))
ok('building midday → at-risk', cloudTrend({ landCloudAm: 3, landCloudMid: 6 }).verdict === 'at-risk', cloudTrend({ landCloudAm: 3, landCloudMid: 6 }))
ok('PM precip over land → collapse signal -1', cloudTrend({ landCloudAm: 2, precipLandPM: true }).signal === -1, cloudTrend({ landCloudAm: 2, precipLandPM: true }))

console.log('confidence')
const cHigh = confidence({ seaBreezeMarginality: 0.9, sigmaTwd: 8, sigmaTws: 1, twsKn: 14 })
const cLowSpread = confidence({ seaBreezeMarginality: 0.5, sigmaTwd: 45, sigmaTws: 5, twsKn: 14 })
const cLight = confidence({ seaBreezeMarginality: 0.9, sigmaTwd: 8, sigmaTws: 1, twsKn: 4 })
ok('agree + breezy → HIGH', cHigh.label === 'HIGH', cHigh)
ok('big spread → not HIGH', cLowSpread.label !== 'HIGH', cLowSpread)
ok('light air caps below HIGH even if models agree', cLight.label !== 'HIGH', cLight)
ok('high > light score (low-wind penalty)', cHigh.score10 > cLight.score10, [cHigh.score10, cLight.score10])

console.log('funnelling field')
// build a synthetic 11x11 grid: uniform westerly base (FROM 270 => u=+, v=0),
// with a Gaussian speed bump near the centre-east (a headland/gap acceleration).
{
  const nx = 11; const ny = 11
  const lo1 = 9.80; const la1 = 44.10; const dx = 0.01; const dy = 0.01  // ~La Spezia-ish
  const u = new Array(nx * ny); const v = new Array(nx * ny)
  const baseMs = 8
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const p = j * nx + i
      // bump centred at (i=6,j=5), adds up to +8 m/s
      const r2 = (i - 6) ** 2 + (j - 5) ** 2
      const spd = baseMs + 8 * Math.exp(-r2 / 4)
      const [uu, vv] = windUV(spd, 270)  // FROM west → eastward flow
      u[p] = uu; v[p] = vv
    }
  }
  const g = { nx, ny, lo1, la1, dx, dy, u, v }
  const diag = funnelDiagnostics(g)
  ok('funnel cores detected at the bump', diag.cores.length > 0, diag.cores.length)
  ok('peak R well above 1.3', diag.sMax / diag.sRef > 1.3, [diag.sMax, diag.sRef])
  // a core should sit on the UPWIND (west, lower i) side of the peak (still accelerating)
  const peakLon = lo1 + 6 * dx
  ok('core biased upwind of peak (downstream of accel)', diag.cores.some((c) => c.lon < peakLon + 1e-9), diag.cores.map((c) => Math.round(c.lon * 100) / 100))
  // funnelFlag near the bump centre = true; far corner = false
  ok('funnelFlag true near bump', funnelFlag(diag, la1 - 5 * dy, lo1 + 5 * dx, 5) === true, true)
  ok('funnelFlag false far away', funnelFlag(diag, la1 - 0 * dy, lo1 + 0 * dx, 1) === false, false)

  // uniform field → no funnelling, R≈1 everywhere, negligible divergence
  const u2 = new Array(nx * ny).fill(windUV(8, 270)[0])
  const v2 = new Array(nx * ny).fill(windUV(8, 270)[1])
  const diagU = funnelDiagnostics({ nx, ny, lo1, la1, dx, dy, u: u2, v: v2 })
  ok('uniform field → no funnel cores', diagU.cores.length === 0, diagU.cores.length)
  ok('uniform field → R≈1', approx(diagU.sMax / diagU.sRef, 1, 0.01), [diagU.sMax, diagU.sRef])
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
