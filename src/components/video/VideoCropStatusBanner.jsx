import React from "react";
import { fmtMmSsLong } from '../ssa/format';

function VideoCropStatusBanner({video, pendingCrop, cropError, onDismissError}){
  const isLocal = !!video.hasLocalBlob;
  // Only render when there's something to say.
  const hasCutMarked = !!(pendingCrop && (pendingCrop.deleteUpTo != null || pendingCrop.deleteFrom != null));
  if (!cropError && !(hasCutMarked && !isLocal)) return null;

  const fullDur = video.duration || 0;
  const startSec = pendingCrop?.deleteUpTo ?? 0;
  const endSec   = pendingCrop?.deleteFrom ?? fullDur;
  const removeSec = Math.max(0, fullDur - Math.max(0, endSec - startSec));

  return (
    <div style={{background:"#071624",borderRadius:7,padding:"9px 11px",border:`1px solid ${cropError?"#EF4444":"#F59E0B"}40`,marginBottom:8}}>
      {cropError ? (
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
          <div style={{fontSize:10,color:"#EF4444",flex:1}}>
            <span style={{fontWeight:700}}>Crop failed.</span> {cropError}
          </div>
          {onDismissError && (
            <button onClick={onDismissError} style={{background:"none",border:"1px solid #EF444440",borderRadius:4,padding:"2px 8px",color:"#EF4444",cursor:"pointer",fontSize:10}}>Dismiss</button>
          )}
        </div>
      ) : (
        <div style={{fontSize:10,color:"#F59E0B"}}>
          Cut marks set (will delete {fmtMmSsLong(removeSec)}), but the original isn't on this device. Open this clip on the device that imported it to apply the crop.
        </div>
      )}
    </div>
  );
}

export { VideoCropStatusBanner };