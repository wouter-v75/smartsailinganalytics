'use client'
import React from "react";

// ─── MOBILE DETECTION ─────────────────────────────────────────────────────────
// True when the device is a phone/tablet — drives a completely different UI shell.
// We use both UA sniffing (reliable for iOS/Android) and screen width as fallback.
function useIsMobile(){
  const [mobile, setMobile] = React.useState(()=>{
    if(typeof window==="undefined") return false;
    const ua = navigator.userAgent||"";
    const isPhone = /iPhone|Android.*Mobile|IEMobile|BlackBerry/i.test(ua);
    const isTablet = /iPad|Android(?!.*Mobile)/i.test(ua);
    return isPhone || isTablet || window.innerWidth < 768;
  });
  React.useEffect(()=>{
    const ua = navigator.userAgent||"";
    const isPhone = /iPhone|Android.*Mobile|IEMobile|BlackBerry/i.test(ua);
    const isTablet = /iPad|Android(?!.*Mobile)/i.test(ua);
    // A phone/tablet is ALWAYS the mobile layout — never width-track it.
    // Previously the resize handler set mobile = matchMedia('max-width:767px'),
    // so rotating a phone to landscape (width > 767) flipped the whole app to
    // the desktop layout, unmounting the mobile player mid-playback. Only a
    // non-touch device (desktop in a narrow window) should follow the width.
    if(isPhone || isTablet){ setMobile(true); return; }
    const mq = window.matchMedia("(max-width:767px)");
    const handler = e => setMobile(e.matches);
    setMobile(mq.matches);
    mq.addEventListener("change", handler);
    return ()=>mq.removeEventListener("change", handler);
  },[]);
  return mobile;
}

export { useIsMobile };