#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse, sys, re
from pathlib import Path
from typing import List, Optional
import pandas as pd

def normalize_col(name: str) -> str:
    if name is None: return ''
    import re as _re
    s = str(name).strip().lower()
    s = _re.sub(r'[^0-9a-z]+', '_', s)
    s = _re.sub(r'_+', '_', s).strip('_')
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

def pick_col(df: pd.DataFrame, candidates):
    for c in candidates:
        if c in df.columns: return c
    return None

def derive_extension(row):
    for c in ['file_extension','file_ext','file_extens','extension']:
        if c in row.index and pd.notna(row[c]):
            return str(row[c]).strip().lower().lstrip('.')
    for c in ['file_path','filepath','path','inputpath']:
        if c in row.index and pd.notna(row[c]):
            import re as _re
            m = _re.search(r'\.([a-z0-9]{1,6})$', str(row[c]).strip().lower())
            if m: return m.group(1)
    return None

def consolidate_status_text(result: str, status: str) -> str:
    r = (str(result) if result is not None else '').lower()
    s = (str(status) if status is not None else '').lower()
    text = f'{r} {s}'
    if any(k in text for k in ['archiv']): return 'Archived'
    if any(k in text for k in ['success','completed','done']): return 'Success'
    if any(k in text for k in ['fail','error','exception','timeout','aborted']): return 'Failed'
    if any(k in text for k in ['skip','unsupported','file type','not applicable','n/a']): return 'Skipped/Unsupported'
    return 'Other'

def add_consolidations(df: pd.DataFrame) -> pd.DataFrame:
    result_col = pick_col(df, ['result'])
    status_col = pick_col(df, ['status','status_message','final_status'])
    df = df.copy()
    df['_result_raw'] = df[result_col] if result_col else ''
    df['_status_raw'] = df[status_col] if status_col else ''
    df['status_consolidated'] = [consolidate_status_text(df['_result_raw'].iloc[i] if i < len(df['_result_raw']) else '',
                                                      df['_status_raw'].iloc[i] if i < len(df['_status_raw']) else '')
                                 for i in range(len(df))]
    df['file_extension_norm'] = df.apply(derive_extension, axis=1)
    return df

def to_html_table(df: pd.DataFrame, index=False):
    if df is None or df.empty: return '<p><em>No data</em></p>'
    return df.to_html(index=index, escape=True, border=0, classes='table compact')

def build_report(df: pd.DataFrame, out_path: Path):
    total_rows = len(df)
    distinct_files = df['_source_file'].nunique() if '_source_file' in df.columns else 0
    by_status = (df.groupby('status_consolidated').size().reset_index(name='count').sort_values('count', ascending=False))
    by_ext = (df.groupby('file_extension_norm').size().reset_index(name='count').sort_values('count', ascending=False).rename(columns={'file_extension_norm':'extension'}))
    dims=[]
    for col in ['source','sourcetype','source_type','commsourcety','comm_source_ty','group','groupname','groupnan','retention','retention1']:
        if col in df.columns:
            t = (df.groupby([col,'status_consolidated']).size().reset_index(name='count').sort_values(['count'], ascending=False))
            dims.append((col, t))
    head = '''{}'''.format(template_head_css)
    tail = '''{}'''.format(template_tail)
    blocks = []
    blocks.append('<h1>File Ingestion Summary</h1>')
    blocks.append(f'<div class="meta">Rows: <strong>{total_rows:,}</strong> · Source files: <strong>{distinct_files}</strong></div>')
    blocks.append('<div class="grid">'
                  + '<div class="card"><div class="label">By Status</div>' + to_html_table(by_status, False) + '</div>'
                  + '<div class="card"><div class="label">By Extension</div>' + to_html_table(by_ext, False) + '</div>'
                  + '</div>')
    blocks.append('<h2>Breakdowns</h2>')
    for name, tbl in dims:
        blocks.append(f'<div class="card"><div class="label">By {name} × Status</div>' + to_html_table(tbl, False) + '</div>')
    html = head + '\n'.join(blocks) + tail
    out_path.write_text(html, encoding='utf-8')

def main():
    parser = argparse.ArgumentParser(description='Combine Excel/CSV files and produce an HTML summary.')
    parser.add_argument('--input','-i', default='./input', help='Input folder')
    parser.add_argument('--output','-o', default='./out', help='Output folder')
    args = parser.parse_args()
    in_dir = Path(args.input).expanduser().resolve()
    out_dir = Path(args.output).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    patterns = ('*.xlsx','*.xlsm','*.xls','*.csv')
    files=[]
    for pat in patterns: files.extend(sorted(in_dir.glob(pat)))
    if not files:
        print(f'No input files found in: {in_dir}', file=sys.stderr); sys.exit(2)
    combined = combine_files(files)
    if combined.empty:
        print('No data rows found across files.', file=sys.stderr); sys.exit(3)
    # write combined
    (out_dir/'combined.csv').write_text(combined.to_csv(index=False), encoding='utf-8')
    with pd.ExcelWriter(out_dir/'combined.xlsx', engine='openpyxl') as w:
        combined.to_excel(w, index=False, sheet_name='combined')
    # consolidate + report
    combined2 = add_consolidations(combined)
    build_report(combined2, out_dir/'summary.html')
    print(f'Wrote: {out_dir / "combined.xlsx"}')
    print(f'Wrote: {out_dir / "combined.csv"}')
    print(f'Wrote: {out_dir / "summary.html"}')

if __name__ == '__main__':
    main()