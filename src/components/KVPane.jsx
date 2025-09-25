import React from "react";

/**
 * rows: [{ key?, content, page?, bbox? }]
 * onHover(row)
 * onLeave()
 * onClick(row)
 */
export default function KVPane({ rows = [], onHover = () => {}, onLeave = () => {}, onClick = () => {} }) {
  return (
    <div style={{ width: 360, height: "100%", overflow: "auto", padding: 8 }}>
      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
        <b>DocAI Elements</b>
        <div>Hover: show DocAI bbox • Click: find true location</div>
      </div>
      <table>
        <thead>
          <tr style={{ textAlign: "left" }}>
            <th style={{ width: 260, padding: "6px 8px" }}>Content</th>
            <th style={{ width: 40, padding: "6px 8px" }}>Page</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              onMouseEnter={() => onHover(row)}
              onMouseLeave={() => onLeave()}
              onClick={() => onClick(row)}
            >
              <td style={{ padding: "6px 8px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {row.content}
              </td>
              <td style={{ padding: "6px 8px", opacity: 0.7 }}>{row.page || "-"}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={2} style={{ padding: 12, opacity: 0.6 }}>
                (No elements)
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}