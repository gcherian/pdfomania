import React from "react";

/**
 * Minimal, robust KV list that ALWAYS calls onHoverRow/onClickRow.
 * Props:
 *   - elements: [{key, content, page, bbox}]
 *   - onHoverRow(row|null)
 *   - onClickRow(row)
 */
export default function KVPane({ elements = [], onHoverRow = () => {}, onClickRow = () => {} }) {
  return (
    <div style={{ padding: 8, overflow: "auto", maxHeight: "calc(100vh - 180px)" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          {elements.map((row, i) => (
            <tr
              key={i}
              onMouseEnter={() => onHoverRow(row)}
              onMouseMove={() => onHoverRow(row)}
              onMouseLeave={() => onHoverRow(null)}
              onClick={() => onClickRow(row)}
              style={{ cursor: "pointer", borderBottom: "1px solid rgba(255,255,255,0.04)" }}
            >
              <td style={{ padding: "8px", width: 52, color: "#cfe3ff", fontSize: 12 }}>{row.page ?? 1}</td>
              <td style={{ padding: "8px" }}>
                <div style={{ color: "#fff", fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{row.content}</div>
                <div style={{ color: "#9fb3d8", fontSize: 12 }}>{row.key || ""}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {elements.length === 0 && <div style={{ color: "#9fb3d8", padding: 8 }}>No elements found.</div>}
    </div>
  );
}