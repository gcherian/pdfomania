import React from "react";

function Row({ row, onHover, onClick }) {
  return (
    <div
      className="kv-row"
      onMouseEnter={() => onHover?.(row)}
      onMouseLeave={() => onHover?.(null)}
      onClick={() => onClick?.(row)}
      title="Hover = DocAI bbox (dashed). Click = find true position (pink)."
    >
      <div className="kv-content">{row.content}</div>
      <div className="kv-page">{row.page ?? "-"}</div>
    </div>
  );
}

export default function KVPane({ header = [], elements = [], onHover, onClick }) {
  return (
    <div className="kv-pane">
      <h3>DocAI Header</h3>
      {header.length === 0 ? (
        <div className="kv-empty">No header found.</div>
      ) : (
        <div className="kv-table">
          <div className="kv-head">
            <div>Key</div>
            <div>Value</div>
          </div>
          <div className="kv-body">
            {header.map((kv, i) => (
              <div className="kv-row" key={`h-${i}`}>
                <div className="kv-key">{kv.key}</div>
                <div className="kv-value">
                  {typeof kv.value === "object" ? JSON.stringify(kv.value) : String(kv.value ?? "")}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <h3 style={{ marginTop: 16 }}>DocAI Elements</h3>
      {elements.length === 0 ? (
        <div className="kv-empty">No elements found.</div>
      ) : (
        <div className="kv-table">
          <div className="kv-head">
            <div>Content</div>
            <div>Page</div>
          </div>
          <div className="kv-body scroll">
            {elements.map((row, i) => (
              <Row key={`e-${i}`} row={row} onHover={onHover} onClick={onClick} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}