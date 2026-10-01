// src/components/Badge360.tsx
// The "360" chip on a clip's thumbnail — shown wherever a video carries the
// Videos tab's 360 tag (lib/sailMedia isVideo360, the same rule Sail media's
// 360 column uses). Display only.

import React from 'react'

export function Badge360({ style }: { style?: React.CSSProperties }) {
  return (
    <span
      title="360 video"
      style={{
        display: 'inline-block', background: 'rgba(124,58,237,0.9)', color: '#fff',
        borderRadius: 3, padding: '0 4px', fontSize: 9, fontWeight: 800, lineHeight: '14px',
        letterSpacing: 0.3, fontFamily: 'ui-monospace, monospace', pointerEvents: 'none', ...style,
      }}
    >360</span>
  )
}
