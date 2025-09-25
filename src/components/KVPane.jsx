import React from "react";

export default function KVPane({ header=[], elements=[], onHover, onClick }) {
  return (
    <div className="left">
      <div className="toolbar">
        <strong>DocAI KV</strong>
      </div>

      <div className="hdr">
        <table>
          <thead><tr><th>Key</th><th>Value</th></tr></thead>
          <tbody>
          {header.length ? header.map((kv,i)=>(
            <tr key={i}>
              <td className="key">{kv.key}</td>
              <td className="cell">{String(kv.value ?? "")}</td>
            </tr>
          )) : <tr><td colSpan={2} className="key">No header found.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="count">{elements.length} elements</div>
      <div className="list">
        <table>
          <tbody>
          {elements.length ? elements.map((row,i)=>(
            <tr key={i}
                className="row"
                onMouseEnter={()=>onHover?.(row)}
                onMouseLeave={()=>onHover?.(null)}
                onClick={()=>onClick?.(row)}>
              <td className="cell">{row.content}</td>
              <td style={{width:32,textAlign:"right",color:"#64748b"}}>{row.page ?? ""}</td>
            </tr>
          )) : <tr><td className="key">No elements found.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}