// src/components/KVPane.jsx
import React from "react";

/**
 * Renders DocAI rows.
 * Hover  → onHover(row)  (dashed bbox)
 * Click  → onClick(row)  (true token match)
 */
export default function KVPane({ rows = [], onHover, onClick }) {
  if (!rows || !rows.length) {
    return (
      <div style={{ padding: 12, fontSize: 13, color: "#888" }}>
        No DocAI elements loaded.
      </div>
    );
  }

  return (
    <div
      style={{
        maxHeight: "calc(100vh - 200px)",
        overflow: "auto",
        border: "1px solid #333",
        borderRadius: 4,
      }}
    >
      <table className="kv-table" style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ background: "#222", color: "#ccc" }}>
            <th style={{ textAlign: "left", padding: "4px 8px" }}>Content</th>
            <th style={{ width: 48, textAlign: "center" }}>Page</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              onMouseEnter={() => onHover?.(row)}
              onMouseLeave={() => onHover?.(null)}
              onClick={() => onClick?.(row)}
              style={{
                cursor: "pointer",
                borderBottom: "1px solid #333",
              }}
            >
              <td
                title={row.content}
                style={{
                  maxWidth: 260,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  padding: "2px 6px",
                  fontSize: 13,
                  color: "#eee",
                }}
              >
                {row.content}
              </td>
              <td style={{ textAlign: "center", fontSize: 12, color: "#aaa" }}>
                {row.page ?? ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}