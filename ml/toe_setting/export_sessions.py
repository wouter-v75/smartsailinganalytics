"""
One-off exporter: pull the 7X's sessions from the SSA store (RLS-scoped) into
local JSON so the notebook can run fully offline.

Nothing is uploaded. This only READS, under a logged-in user's token, exactly
the sessions that membership is allowed to see — the same scoping the app uses.

Usage:
    export SSA_SUPABASE_URL=https://<project>.supabase.co
    export SSA_SUPABASE_ANON_KEY=<anon key>      # from .env.local
    export SSA_SUPABASE_TOKEN=<a user access token / JWT>
    export SSA_BOAT_ID=<northstar 7x boat uuid>
    export SSA_TEAM_ID=<team uuid>               # optional but recommended
    python export_sessions.py

Writes one file per session to Config.local_data_dir as <date>.json containing
{date, log_data, xml_data}. After this, unset the SSA_SUPABASE_* vars and the
loader reads purely from disk.

Where to get the token: open the SSA app in your browser while logged in as a
member of the 7X team, devtools → Application → Local Storage → the Supabase auth
entry → copy `access_token`. It is short-lived; re-export when it expires.
"""

from __future__ import annotations

import json
import os

from config import CFG
from data_loader import _load_sessions_supabase


def main() -> None:
    os.makedirs(CFG.local_data_dir, exist_ok=True)
    sessions = _load_sessions_supabase(CFG)
    n = 0
    for s in sessions:
        date = s.get("date")
        if not date:
            continue
        path = os.path.join(CFG.local_data_dir, f"{date}.json")
        with open(path, "w") as f:
            json.dump(
                {"date": date,
                 "log_data": s.get("log_data"),
                 "xml_data": s.get("xml_data")},
                f,
            )
        n += 1
    print(f"Exported {n} session(s) → {CFG.local_data_dir}")
    print("Add a 'sea_state' map per file from the debrief notes before fitting "
          "(leg_id → flat|moderate|lumpy).")


if __name__ == "__main__":
    main()
