#!/usr/bin/env python3
"""Parse SailScan PDFs into a unified ground-truth dataset paired with photos."""
import json
import re
import subprocess
from pathlib import Path

ROOT = Path("/sessions/youthful-exciting-maxwell/mnt/Code--ssa/docs/sailscan/training-set")
OUTPUT = ROOT / "ground-truth.json"

METRIC_LABELS = [
    ("Camber [%]",       "camberPct"),
    ("Draft [%]",        "draftPct"),
    ("Twist [°]",        "twistDeg"),
    ("Fore Camber [%]",  "foreCamberPct"),
    ("Back Camber [%]",  "backCamberPct"),
    ("Entry Angle [°]",  "entryAngleDeg"),
    ("Exit Angle [°]",   "exitAngleDeg"),
]

POS_MAP = {"7": 75, "5": 50, "2": 25}

def signatures(text: str) -> dict:
    sig = {}
    for m in re.finditer(r"(\d+(?:[.,]\d+)?)\s*T(?:ons?)?\s*Forestay", text, re.IGNORECASE):
        sig["forestayT"] = float(m.group(1).replace(",", "."))
    for m in re.finditer(r"(\d+(?:[.,]\d+)?)\s*T(?:ons?)?\s*Backstay", text, re.IGNORECASE):
        sig["backstayT"] = float(m.group(1).replace(",", "."))
    # Allow any non-word separator (underscore, comma, space) between kg and Jib
    for m in re.finditer(r"(\d{2,4})\s*kg[^A-Za-z0-9]*[Jj]ib(?:[^A-Za-z0-9]*[Tt]ack)?", text):
        sig["jibTackKg"] = int(m.group(1))
    if "jibTackKg" not in sig:
        m = re.search(r"shims_(\d{3,4})\.\.\.", text)
        if m:
            sig["jibTackKgPrefix"] = int(m.group(1))
    for m in re.finditer(r"(\d+)\s*-\s*(\d+)?\s*Kn?\s*TWS", text, re.IGNORECASE):
        a = m.group(1); b = m.group(2)
        sig["twsRange"] = f"{a}-{b}" if b else a
    for m in re.finditer(r"(20\d{2})-(\d{2})-(\d{2})", text):
        sig["date"] = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
        break
    if "date" not in sig:
        for m in re.finditer(r"(\d{2}):(\d{2}):(\d{2,4})", text):
            d, mo, y = m.group(1), m.group(2), m.group(3)
            if len(y) == 2: y = "20" + y
            sig["date"] = f"{y}-{mo}-{d}"
            break
    return sig

def sig_match_score(folder_sig, pdf_sig):
    score = 0
    if "jibTackKg" in folder_sig and "jibTackKg" in pdf_sig and folder_sig["jibTackKg"] == pdf_sig["jibTackKg"]:
        score += 5
    elif "jibTackKg" in folder_sig and "jibTackKgPrefix" in pdf_sig:
        if str(folder_sig["jibTackKg"]).startswith(str(pdf_sig["jibTackKgPrefix"])):
            score += 4
    if "forestayT" in folder_sig and "forestayT" in pdf_sig and abs(folder_sig["forestayT"] - pdf_sig["forestayT"]) < 0.05:
        score += 3
    if "backstayT" in folder_sig and "backstayT" in pdf_sig and abs(folder_sig["backstayT"] - pdf_sig["backstayT"]) < 0.05:
        score += 2
    if "date" in folder_sig and "date" in pdf_sig and folder_sig["date"] == pdf_sig["date"]:
        score += 2
    if "twsRange" in folder_sig and "twsRange" in pdf_sig and folder_sig["twsRange"] == pdf_sig["twsRange"]:
        score += 1
    return score

def pdftotext_raw(pdf_path):
    return subprocess.check_output(["pdftotext", "-raw", str(pdf_path), "-"]).decode("utf-8", "replace")

def parse_pos_value_line(line):
    m = re.match(r"\s*(7|5|2)(?:\.\.\.|\.\d+|\d)?(.*)$", line)
    if not m:
        return None
    prefix = m.group(1)
    if prefix not in POS_MAP:
        return None
    pos = POS_MAP[prefix]
    rest = m.group(2)
    vals = re.findall(r"-?\d+\.\d+", rest)
    if not vals:
        return None
    return pos, vals

def parse_pdf_sessions(pdf_path):
    text = pdftotext_raw(pdf_path)
    lines = text.splitlines()
    venue_idx = next((i for i, ln in enumerate(lines) if re.match(r"^\s*Image\s+Venue", ln)), None)
    venue_rows = []
    if venue_idx is not None:
        for j in range(venue_idx + 1, len(lines)):
            line = lines[j].strip()
            if not line: continue
            if line.startswith("sailscan.thesailcloud") or line.startswith("Draft Stripe"): break
            if not (line.startswith("J") or line.startswith("P") or line.startswith("M")): continue
            venue_rows.append(line)
    if not venue_rows:
        for line in lines:
            if re.search(r"20\d{2}-\d{2}-\d{2}", line) and not re.search(r"\bDate\b", line):
                venue_rows.append(line.strip())
    seen = set(); ordered_rows = []
    for r in venue_rows:
        if r not in seen:
            seen.add(r); ordered_rows.append(r)
    n = 0
    for line in lines:
        pv = parse_pos_value_line(line)
        if pv:
            n = len(pv[1])
            break
    if n < 1: return []
    metrics_per_col = [{} for _ in range(n)]
    for label, key in METRIC_LABELS:
        idx = next((i for i, ln in enumerate(lines) if label in ln), None)
        if idx is None: continue
        rows = 0
        for j in range(idx + 1, min(idx + 30, len(lines))):
            pv = parse_pos_value_line(lines[j])
            if not pv: continue
            pos, vals = pv
            if len(vals) < n: continue
            for ci in range(n):
                metrics_per_col[ci].setdefault(key, {})[str(pos)] = float(vals[ci])
            rows += 1
            if rows >= 3: break
    return [{"headerRowText": (ordered_rows[ci] if ci < len(ordered_rows) else "")[:200],
             "signatures": signatures(ordered_rows[ci] if ci < len(ordered_rows) else ""),
             "metrics": metrics_per_col[ci],
             "isSingleSession": n == 1} for ci in range(n)]

def main():
    folder_dirs = sorted([d for d in ROOT.iterdir() if d.is_dir()], key=lambda d: d.name)
    folder_signatures = {f.name: signatures(f.name) for f in folder_dirs}
    pdf_paths = sorted({p.resolve() for p in ROOT.rglob("SailScan*.pdf")})

    pdf_sessions = {}
    for p in pdf_paths:
        try:
            pdf_sessions[p] = parse_pdf_sessions(p)
        except Exception as e:
            print(f"  ! failed to parse {p.name}: {e}")

    # Pass 1: match every folder to a single-session PDF if possible.
    # Pass 2: for unmatched folders, match them to columns of multi-session
    #         PDFs that haven't already been attributed by metric signature
    #         to a single-session PDF (i.e. true "new" sessions).
    single_metric_keys = set()
    for pdf_path, sessions in pdf_sessions.items():
        if any(s.get("isSingleSession") for s in sessions) and len(sessions) == 1:
            single_metric_keys.add(json.dumps(sessions[0]["metrics"], sort_keys=True))

    final = []
    seen_metric_signatures = set()
    for folder in folder_dirs:
        fsig = folder_signatures[folder.name]
        photos = sorted(f.name for f in folder.iterdir()
                        if f.suffix.lower() in (".jpg", ".jpeg", ".png", ".heic"))
        # Prefer single-session PDFs over multi-session aggregates (avoids the
        # ambiguity when 2+ sessions in one PDF have identical truncated names).
        candidates = []
        for pdf_path, sessions in pdf_sessions.items():
            for sess in sessions:
                if not sess["metrics"]: continue
                score = sig_match_score(fsig, sess["signatures"])
                if score >= 5:
                    msig_local = json.dumps(sess["metrics"], sort_keys=True)
                    is_dup_of_single = (not sess["isSingleSession"]) and (msig_local in single_metric_keys)
                    candidates.append((sess["isSingleSession"], not is_dup_of_single, score, sess, pdf_path))
        if not candidates:
            print(f"  ! no confident match for: {folder.name[:80]}")
            print(f"    folder sig: {fsig}")
            continue
        # Sort: single-session first, then highest score
        candidates.sort(key=lambda x: (not x[0], not x[1], -x[2]))
        _, _, best_score, best, best_pdf = candidates[0]
        msig = json.dumps(best["metrics"], sort_keys=True)
        if msig in seen_metric_signatures:
            print(f"  · dedupe (already seen these metrics): {folder.name[:60]}")
            continue
        seen_metric_signatures.add(msig)
        final.append({
            "folder": folder.name,
            "folderSignature": fsig,
            "matchedHeaderRow": best["headerRowText"][:120].strip(),
            "matchedSignature": best["signatures"],
            "matchScore": best_score,
            "isSingleSessionPdf": best["isSingleSession"],
            "sourcePdf": best_pdf.name,
            "photos": photos,
            "metrics": best["metrics"],
        })

    out = {
        "$comment": "SailScan v2 ground-truth dataset, parsed from sailscan.thesailcloud PDF reports paired with original photos. Stripe convention: '25'=top stripe (head), '50'=middle, '75'=bottom (foot). Built by tools/parse-sailscan-pdfs.py.",
        "stripePositions": {
            "25": "top stripe (near head)",
            "50": "middle stripe",
            "75": "bottom stripe (near foot)",
        },
        "sessionCount": len(final),
        "sessions": final,
    }
    OUTPUT.write_text(json.dumps(out, indent=2))
    print(f"\n=== Wrote {len(final)} sessions ===")
    for s in final:
        single = "single" if s["isSingleSessionPdf"] else "multi"
        print(f"  · {s['folder'][:80]}")
        print(f"    photos={s['photos']}, score={s['matchScore']}, {single}-session pdf={s['sourcePdf']}")

if __name__ == "__main__":
    main()
