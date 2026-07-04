// Shared instrument-overlay renderer for photos. Draws the image plus the
// gauge/sail/mast overlays onto a canvas. Used by both the Photos tab and the
// timeline photo lightbox so the overlay looks identical in both places.
//
// `inst` fields: tws, twa, awa, bsp, heel, vmg, keelAng, sails[], location,
// boat, mast_var_manual_* and an optional `extra` array of {l,v,c} gauges.

export const R = (n, d = 1) => (n == null || isNaN(n) ? '--' : Number(n).toFixed(d))

export function renderOverlay(canvas, img, inst) {
  const ctx = canvas.getContext('2d')
  canvas.width = img.naturalWidth || img.width
  canvas.height = img.naturalHeight || img.height
  ctx.drawImage(img, 0, 0)
  const W = canvas.width, H = canvas.height, scale = Math.min(W, H) / 1000
  // Larger gauge boxes so the data reads clearly on big/full-res photos.
  const fs = Math.max(14, Math.round(20 * scale)), pad = Math.round(14 * scale)
  const bw = Math.round(128 * scale), bh = Math.round(74 * scale), gap = Math.round(10 * scale)
  const gauges = [
    { l: 'TWS', v: inst.tws != null ? R(inst.tws) + ' kn' : '--', c: '#7DD3FC' },
    { l: 'TWA', v: inst.twa != null ? R(inst.twa, 0) + '°' : '--', c: '#7DD3FC' },
    { l: 'AWA', v: inst.awa != null ? R(inst.awa, 0) + '°' : '--', c: '#7DD3FC' },
    { l: 'BSP', v: inst.bsp != null ? R(inst.bsp) + ' kn' : '--', c: '#10B981' },
    { l: 'Heel', v: inst.heel != null ? R(inst.heel, 0) + '°' : '--', c: '#F97316' },
    { l: 'VMG', v: inst.vmg != null ? R(inst.vmg) + ' kn' : '--', c: '#22C55E' },
    { l: 'Keel', v: inst.keelAng != null ? R(inst.keelAng, 1) + '°' : '--', c: '#F59E0B' },
  ]
  // User-added variables (session only) drawn after the fixed gauges.
  if (Array.isArray(inst.extra)) for (const g of inst.extra) gauges.push(g)
  const cols = 3, rows = Math.ceil(gauges.length / cols)
  const sx = W - cols * bw - (cols - 1) * gap - pad, sy = H - rows * bh - (rows - 1) * gap - pad
  gauges.forEach((g, i) => {
    const x = sx + (i % cols) * (bw + gap), y = sy + Math.floor(i / cols) * (bh + gap)
    ctx.fillStyle = 'rgba(3,15,26,0.82)'; ctx.beginPath()
    if (ctx.roundRect) ctx.roundRect(x, y, bw, bh, 5); else ctx.rect(x, y, bw, bh); ctx.fill()
    ctx.strokeStyle = g.c + '60'; ctx.lineWidth = 1.5; ctx.beginPath()
    if (ctx.roundRect) ctx.roundRect(x, y, bw, bh, 5); else ctx.rect(x, y, bw, bh); ctx.stroke()
    ctx.fillStyle = '#64748B'; ctx.font = `${Math.round(fs * 0.65)}px monospace`; ctx.textAlign = 'center'
    ctx.fillText(g.l.toUpperCase(), x + bw / 2, y + Math.round(bh * 0.35))
    ctx.fillStyle = g.c; ctx.font = `bold ${fs}px monospace`
    ctx.fillText(g.v, x + bw / 2, y + Math.round(bh * 0.72))
  })
  if (inst.sails?.length) {
    const txt = inst.sails.join(' · ')
    ctx.font = `${Math.round(fs * 0.75)}px monospace`
    const tw = ctx.measureText(txt).width + pad * 2, th = Math.round(bh * 0.6)
    ctx.fillStyle = 'rgba(3,15,26,0.82)'; ctx.beginPath()
    if (ctx.roundRect) ctx.roundRect(pad, pad, tw, th, 5); else ctx.rect(pad, pad, tw, th); ctx.fill()
    ctx.fillStyle = '#F59E0B'; ctx.textAlign = 'left'; ctx.fillText(txt, pad * 1.5, pad + Math.round(th * 0.72))
  }
  if (inst.location || inst.boat) {
    const badge = [inst.boat, inst.location].filter(Boolean).join(' · ')
    ctx.font = `${Math.round(fs * 0.65)}px monospace`
    const bwb = ctx.measureText(badge).width + pad * 2, bhb = Math.round(bh * 0.55)
    ctx.fillStyle = 'rgba(3,15,26,0.82)'; ctx.beginPath()
    if (ctx.roundRect) ctx.roundRect(W - bwb - pad, pad, bwb, bhb, 5); else ctx.rect(W - bwb - pad, pad, bwb, bhb); ctx.fill()
    ctx.fillStyle = '#94A3B8'; ctx.textAlign = 'right'; ctx.fillText(badge, W - pad * 1.5, pad + Math.round(bhb * 0.72))
  }
  // Mast settings overlay (bottom-left, above instrument gauges)
  const mastFields = [
    inst.mast_var_manual_setting && inst.mast_var_manual_setting !== 'base' ? `Set:${inst.mast_var_manual_setting}` : null,
    inst.mast_var_manual_chins ? `Ch:${inst.mast_var_manual_chins}` : null,
    inst.mast_var_manual_rake ? `Rk:${inst.mast_var_manual_rake}` : null,
    inst.mast_var_manual_butt ? `Bt:${inst.mast_var_manual_butt}` : null,
    inst.mast_var_manual_v1 ? `V1:${inst.mast_var_manual_v1}` : null,
    inst.mast_var_manual_d1 ? `D1:${inst.mast_var_manual_d1}` : null,
    inst.mast_var_manual_d2 ? `D2:${inst.mast_var_manual_d2}` : null,
  ].filter(Boolean)
  if (mastFields.length > 0) {
    const mastTxt = '⛵ ' + mastFields.join(' · ')
    ctx.font = `${Math.round(fs * 0.7)}px monospace`
    const mtw = ctx.measureText(mastTxt).width + pad * 2, mth = Math.round(bh * 0.6)
    const my = H - rows * bh - (rows - 1) * gap - pad - mth - gap
    ctx.fillStyle = 'rgba(3,15,26,0.82)'; ctx.beginPath()
    if (ctx.roundRect) ctx.roundRect(pad, my, mtw, mth, 5); else ctx.rect(pad, my, mtw, mth); ctx.fill()
    ctx.strokeStyle = '#F9731640'; ctx.lineWidth = 1; ctx.beginPath()
    if (ctx.roundRect) ctx.roundRect(pad, my, mtw, mth, 5); else ctx.rect(pad, my, mtw, mth); ctx.stroke()
    ctx.fillStyle = '#F97316'; ctx.textAlign = 'left'; ctx.fillText(mastTxt, pad * 1.5, my + Math.round(mth * 0.72))
  }
}
