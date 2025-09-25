import React from "react";

/**
 * @param {{
 *  headerRows: {key:string, content:string, page:number, bbox:any}[],
 *  elementRows: {content:string, page:number, bbox:any}[],
 *  onHoverRow: (row:any)=>void,
 *  onClickRow: (row:any)=>void,
 * }} props
 */
export default function KVPane({ headerRows, elementRows, onHoverRow, onClickRow }) {
  return (
    <div className="kvpane">
      <div className="kv-section">
        <div className="kv-title">DocAI Header</div>
        <div className="kv-table">
          <div className="kv-th">
            <div className="c1">Key</div>
            <div className="c2">Value</div>
          </div>
          {(headerRows || []).map((r, i) => (
            <div
              className="kv-tr"
              key={`h-${i}`}
              onMouseEnter={() => onHoverRow(r)}
              onMouseLeave={() => onHoverRow(null)}
              onClick={() => onClickRow(r)}
              title="Hover: DocAI box • Click: find true location"
            >
              <div className="c1">{r.key}</div>
              <div className="c2">{r.content}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="kv-section" style={{ marginTop: 16 }}>
        <div className="kv-title">DocAI Elements</div>
        <div className="kv-table">
          <div className="kv-th">
            <div className="c2">Content</div>
            <div className="c3">Page</div>
          </div>
          {(elementRows || []).map((r, i) => (
            <div
              className="kv-tr"
              key={`e-${i}`}
              onMouseEnter={() => onHoverRow(r)}
              onMouseLeave={() => onHoverRow(null)}
              onClick={() => onClickRow(r)}
              title="Hover: DocAI box • Click: find true location"
            >
              <div className="c2">{r.content}</div>
              <div className="c3">{r.page || ""}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}