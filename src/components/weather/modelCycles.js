// Shared model run-cycle context.
//
// Fetches the latest init cycle (00/06/12/18z) for every model once, near the
// top of the Weather tab, and hands it to every sub-view so model names can be
// shown as e.g. "AROME 00z" / "Icon-Race 00z" consistently across tables,
// pickers and graphs. Refreshes every 10 minutes (model runs are hours apart).

import React, { createContext, useContext, useEffect, useState } from 'react'
import { loadAllModelCycles } from './openMeteo'

const REFRESH_MS = 10 * 60 * 1000
const CyclesCtx = createContext({})

export function ModelCyclesProvider({ children }) {
  const [cycles, setCycles] = useState({})
  useEffect(() => {
    let alive = true
    const run = () => loadAllModelCycles()
      .then((c) => { if (alive) setCycles(c) })
      .catch(() => {})
    run()
    const id = setInterval(run, REFRESH_MS)
    return () => { alive = false; clearInterval(id) }
  }, [])
  return <CyclesCtx.Provider value={cycles}>{children}</CyclesCtx.Provider>
}

// Map of modelKey -> "00z" tag (empty for models whose cycle is unknown).
export const useModelCycles = () => useContext(CyclesCtx)
