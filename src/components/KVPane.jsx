import React from "react";

/**
 * props:
 *  - header: array
 *  - rows: [{content,page,bbox}]
 *  - onHover(row|null)
 *  - onClick(row)
 */
export default function KVPane({ header = [], rows = [], onHover = ()=>{}, onClick = ()=>{} }) {
  return (
    <div>
      <div className="kv-head">DocAI — Extraction</div>
      <div className="small">Upload DocAI JSON to populate these fields</div>

      <div style={{marginTop:8, marginBottom:8}}>
        <div style={{fontWeight:600, color:"#fff", marginBottom:6}}>Header</div>
        <div style={{fontSize:13, color:"#9fb0bd", marginBottom:12}}>
          {header.length ? header.map((h,i)=>(<div key={i}><strong>{h.key}</strong>: {String(h.value)}</div>)) : <div style={{opacity:.6}}>No header</div>}
        </div>
      </div>

      <div style={{fontWeight:600, color:"#fff", marginBottom:6}}>Elements</div>
      <div className="small">Hover = DocAI bbox • Click = locate true position</div>

      <table className="kv-table" style={{marginTop:8}}>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={i}
              onMouseEnter={() => onHover(r)}
              onMouseLeave={() => onHover(null)}
              onClick={() => onClick(r)}
            >
              <td style={{maxWidth:240, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{r.content}</td>
              <td style={{width:48, textAlign:"right"}}>{r.page}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}