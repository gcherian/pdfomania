import React from "react";
import { DocElement } from "./docai";

export default function KVPane({
  rows,
  onHover,
  onLeave,
  onClick,
}: {
  rows: DocElement[];
  onHover: (r: DocElement) => void;
  onLeave: () => void;
  onClick: (r: DocElement) => void;
}) {
  return (
    <div className="kvwrap">
      <table className="kv">
        <thead>
          <tr><th style={{width:"80%"}}>Content</th><th>Page</th></tr>
        </thead>
        <tbody>
          {rows.length ? rows.map((r, i) => (
            <tr
              key={i + ":" + (r.page ?? "")}
              onMouseEnter={() => onHover(r)}
              onMouseLeave={onLeave}
              onClick={() => onClick(r)}
              title="Hover: DocAI bbox • Click: best-match highlight"
            >
              <td style={{whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{r.content}</td>
              <td style={{textAlign:"right"}}>{r.page}</td>
            </tr>
          )) : (
            <tr><td colSpan={2} className="muted">No elements loaded yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function KVPane({ header, rows, onHover, onClick }) {
  return (
    <div className="kvpane">
      <div className="section-title">DocAI Header</div>
      {/* header table … */}

      <div className="section-title">DocAI Elements</div>
      <div className="hint">Hover: DocAI bbox • Click: locate true position</div>
      <table className="tbl">
        <thead><tr><th>Content</th><th>Page</th></tr></thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}
                onMouseEnter={() => onHover(row)}
                onClick={() => onClick(row)}>
              <td>{row.content}</td>
              <td style={{width:36, textAlign:"right"}}>{row.page}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}