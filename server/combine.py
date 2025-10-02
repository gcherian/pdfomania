#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse, sys, re
from pathlib import Path
from typing import List, Optional, Tuple
import pandas as pd

# ---------------- Normalization helpers ----------------
def normalize_col(name: str) -> str:
    if name is None: return ''
    s = str(name).strip().lower()
    s = re.sub(r'[^0-9a-z]+', '_', s)
    s = re.sub(r'_+', '_', s).strip('_')
    return s or 'unnamed'

def read_excel_best_effort(path: Path) -> pd.DataFrame:
    try:
        if path.suffix.lower() in ['.xlsx', '.xlsm']:
            xls = pd.ExcelFile(path, engine='openpyxl')
        else:
            xls = pd.ExcelFile(path, engine='xlrd')
    except Exception as e:
        raise RuntimeError(f"Failed to open Excel '{path.name}': {e}")
    chosen = None
    for sheet in xls.sheet_names:
        df = xls.parse(sheet)
        if not df.empty and df.dropna(how='all').shape[0] > 0:
            chosen = sheet; break
    if chosen is None and xls.sheet_names: chosen = xls.sheet_names[0]
    return xls.parse(chosen) if chosen else pd.DataFrame()

def read_any(path: Path) -> pd.DataFrame:
    ext = path.suffix.lower()
    if ext in ['.xlsx', '.xlsm', '.xls']:
        df = read_excel_best_effort(path)
    elif ext == '.csv':
        df = None
        for enc in ('utf-8-sig','utf-8','cp1252','latin1'):
            try: df = pd.read_csv(path, encoding=enc); break
            except Exception: df=None
        if df is None: df = pd.read_csv(path, encoding='utf-8', errors='ignore')
    else:
        raise ValueError(f'Unsupported file type: {path.name}')
    df = df.dropna(how='all')
    df.columns = [normalize_col(c) for c in df.columns]
    return df

def combine_files(files: List[Path]) -> pd.DataFrame:
    frames=[]
    for f in files:
        try:
            df = read_any(f)
            if df.empty: continue
            df.insert(0, '_source_file', f.name)
            frames.append(df)
        except Exception as e:
            print(f"[WARN] Skipping '{f.name}': {e}", file=sys.stderr)
    if not frames: return pd.DataFrame()
    combined = pd.concat(frames, axis=0, ignore_index=True, sort=False)
    combined = combined.loc[:, ~combined.columns.duplicated()]
    return combined

# --------------- Filtering logic ---------------
def pick_status_col(df: pd.DataFrame) -> Optional[str]:
    for c in ['status','status_message','final_status']:
        if c in df.columns: return c
    for c in df.columns:
        if 'status' in c: return c
    return None

def normalize_text_for_match(s: str) -> str:
    s = (s or '').lower()
    s = re.sub(r'[^a-z ]+', ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s

IGNORE_PATTERNS = [
    'archival completed and file deleted',
    'archeival completed and file deleted',
    'archieval completed and file deleted',
]
IGNORE_PATTERNS = [normalize_text_for_match(p) for p in IGNORE_PATTERNS]

def filter_ignored_rows(df: pd.DataFrame) -> Tuple[pd.DataFrame, int]:
    status_col = pick_status_col(df)
    if not status_col:
        return df, 0
    norm = df[status_col].astype(str).map(normalize_text_for_match)
    mask_ignore = norm.isin(IGNORE_PATTERNS)
    ignored = int(mask_ignore.sum())
    kept_df = df.loc[~mask_ignore].copy()
    return kept_df, ignored

# --------------- HTML report ---------------
def to_html_table(df: pd.DataFrame, index=False):
    if df is None or df.empty: return '<p><em>No data</em></p>'
    return df.to_html(index=index, escape=True, border=0, classes='table compact')

HTML_HEAD = '''<!doctype html>
<html><head><meta charset="utf-8"><title>File Ingestion Summary</title>
<style>
body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;margin:24px;}
h1{margin-bottom:.2rem}.meta{color:#555;margin-bottom:1rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.card{border:1px solid #e5e7eb;border-radius:8px;padding:16px}
.label{color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
table.table{width:100%;border-collapse:collapse;font-size:14px}
table.table th,table.table td{border-bottom:1px solid #eee;padding:6px 8px;text-align:left}
table.table tr:hover{background:#fafafa}
.compact td,.compact th{padding:6px 8px}
.caption{color:#666;font-size:12px;margin:6px 0 10px}
</style></head><body>'''

HTML_TAIL = '<p class="caption">Only rows whose Status â  âArchival Completed and File Deletedâ are included.</p></body></html>'

def build_report(df: pd.DataFrame, ignored_count: int, out_path: Path):
    total_rows = len(df)
    distinct_files = df['_source_file'].nunique() if '_source_file' in df.columns else 0
    pivots = []
    if 'status' in df.columns:
        pivots.append(('Status (raw)', df.groupby('status').size().reset_index(name='count').sort_values('count', ascending=False)))
    # Extension if any
    ext_col = None
    for c in ['file_extension','file_ext','file_extens','extension']:
        if c in df.columns: ext_col = c; break
    if ext_col:
        pivots.append(('By Extension', df.groupby(ext_col).size().reset_index(name='count').sort_values('count', ascending=False).rename(columns={ext_col:'extension'})))
    # Build HTML
    blocks = []
    blocks.append('<h1>Exception Report</h1>')
    blocks.append(f'<div class="meta">Included rows: <strong>{total_rows:,}</strong> Â· Source files: <strong>{distinct_files}</strong> Â· Ignored rows: <strong>{ignored_count:,}</strong></div>')
    for title, tbl in pivots:
        blocks.append('<div class="card"><div class="label">'+title+'</div>'+to_html_table(tbl, False)+'</div>')
    html = HTML_HEAD + '\n'.join(blocks) + HTML_TAIL
    out_path.write_text(html, encoding='utf-8')

# --------------- Main ---------------
def main():
    parser = argparse.ArgumentParser(description='Combine files, drop âArchival Completed and File Deletedâ, and report the rest.')
    parser.add_argument('--input','-i', default='./input', help='Input folder')
    parser.add_argument('--output','-o', default='./out', help='Output folder')
    args = parser.parse_args()
    in_dir = Path(args.input).expanduser().resolve()
    out_dir = Path(args.output).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    patterns = ('*.xlsx','*.xlsm','*.xls','*.csv')
    files=[]
    for pat in patterns: files.extend(sorted(in_dir.glob(pat)))
    if not files: print(f'No input files found in: {in_dir}', file=sys.stderr); sys.exit(2)

    combined = combine_files(files)
    if combined.empty: print('No data rows found across files.', file=sys.stderr); sys.exit(3)

    # Save raw combined (audit)
    with pd.ExcelWriter(out_dir/'combined_raw.xlsx', engine='openpyxl') as w:
        combined.to_excel(w, index=False, sheet_name='combined_raw')
    combined.to_csv(out_dir/'combined_raw.csv', index=False)

    # Filter ignored status
    filtered, ignored = filter_ignored_rows(combined)

    # Save filtered results
    with pd.ExcelWriter(out_dir/'combined_filtered.xlsx', engine='openpyxl') as w:
        filtered.to_excel(w, index=False, sheet_name='exceptions_only')
    filtered.to_csv(out_dir/'combined_filtered.csv', index=False)

    # HTML summary
    build_report(filtered, ignored, out_dir/'summary.html')

    print(f'Wrote: {out_dir/"combined_raw.xlsx"}')
    print(f'Wrote: {out_dir/"combined_raw.csv"}')
    print(f'Wrote: {out_dir/"combined_filtered.xlsx"}')
    print(f'Wrote: {out_dir/"combined_filtered.csv"}')
    print(f'Wrote: {out_dir/"summary.html"}')

if __name__ == '__main__':
    main()