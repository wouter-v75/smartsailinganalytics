
// Inject mobile-specific CSS once (touch targets, overscroll, safe areas)
let _mobileStyleInjected = false;

function injectMobileCSS(){
  if(_mobileStyleInjected||typeof document==="undefined") return;
  _mobileStyleInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    .ssa-mobile { -webkit-tap-highlight-color:transparent; touch-action:manipulation; }
    .ssa-mobile * { -webkit-overflow-scrolling:touch; }
    .ssa-mobile input, .ssa-mobile button, .ssa-mobile select { font-size:16px !important; }
    .ssa-mobile video { object-fit:contain; }
    .ssa-mob-card { min-height:44px; }
    @supports(padding:env(safe-area-inset-bottom)){
      .ssa-mob-bottom-nav { padding-bottom:env(safe-area-inset-bottom); }
    }
    @keyframes ssa-spin { to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(s);
}

export { _mobileStyleInjected, injectMobileCSS };