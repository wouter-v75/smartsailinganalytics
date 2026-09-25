'use client'
import * as React from 'react'
import SailTrimTab from '@/components/sailtrim/SailTrimTab'

// Preview harness for the SailTrim digitiser (Tools → SailTrim), so the tool can
// be opened and driven against a real frame without a signed-in session, a team
// and a boat behind it. Dev-only, like the rest of /dev/*.
//
// Give it an ORIGINAL camera file. A speed-team compilation will not do: those
// panels have been cropped, upscaled ~2.3× and — as the 6 Sept set shows —
// ROTATED to stand the mast up, which silently redefines what "horizontal"
// means in the picture.
// `?src=/some.jpg` loads a frame straight from a URL, so the tool can be driven
// without a file picker.
export default function SailTrimHarness() {
  const [src, setSrc] = React.useState('')
  React.useEffect(() => {
    setSrc(new URLSearchParams(window.location.search).get('src') || '')
  }, [])
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <SailTrimTab boatName="Northstar 76" initialFileUrl={src} />
    </div>
  )
}
