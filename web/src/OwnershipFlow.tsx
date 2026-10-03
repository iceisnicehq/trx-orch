import {useEffect,useRef} from 'react';
import cytoscape from 'cytoscape';

export type FlowNode={id:string;type:'holding'|'transfer';wallet:string;amountSun:number;nativeSun?:number;day:number;sequence?:number;status:string;rank:number};
export type FlowEdge={id:string;from:string;to:string;amountSun:number;status:string};
export type Flow={nodes:FlowNode[];edges:FlowEdge[];splits:number;merges:number};
const fmt=(sun:number)=>(sun/1_000_000).toFixed(3);
const xml=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

export function OwnershipFlow({flow,owner,members,maxDay}:{flow:Flow;owner:string;members:{address:string;ordinal:number}[];maxDay:number}){
  const container=useRef<HTMLDivElement>(null),core=useRef<cytoscape.Core|null>(null),structure=useRef('');
  const name=(address:string)=>{const member=members.find(m=>m.address===address);return member?`Node ${member.ordinal+1}`:'Teacher';};
  useEffect(()=>{
    if(!container.current)return;
    const cy=cytoscape({container:container.current,layout:{name:'preset'},elements:[],minZoom:.08,maxZoom:3,
      style:[
        {selector:'node',style:{shape:'round-rectangle',width:142,height:62,'background-color':'#173849','border-width':2,'border-color':'#b9f35a',
          label:'data(label)','text-wrap':'wrap','text-max-width':'138px','text-valign':'center','text-halign':'center','font-family':'system-ui','font-size':11,color:'#e4f2f5'}},
        {selector:'node[type="transfer"]',style:{shape:'hexagon',width:138,height:70,'background-color':'#26394c'}},
        {selector:'node[status="CONFIRMED"],node[status="INITIAL"]',style:{'border-color':'#62d9d1'}},
        {selector:'node[status="PLANNED"],node[status="APPROVED"]',style:{'border-style':'dashed'}},
        {selector:'edge',style:{width:2,'line-color':'#b9f35a','target-arrow-color':'#b9f35a','target-arrow-shape':'triangle','curve-style':'bezier','line-style':'dashed','arrow-scale':1.1}},
        {selector:'edge[status="CONFIRMED"]',style:{'line-color':'#62d9d1','target-arrow-color':'#62d9d1','line-style':'solid'}},
        {selector:'edge[status="HOLD"]',style:{'line-color':'#61778e','target-arrow-color':'#61778e','line-style':'solid',width:1.4}},
        {selector:'edge:selected',style:{label:'data(label)',color:'#e6f7f2','font-size':11,'text-background-color':'#132b39','text-background-opacity':1,'text-background-padding':'4px'}}
      ]});
    core.current=cy;structure.current='';return()=>{cy.destroy();core.current=null;};
  },[owner]);
  useEffect(()=>{
    const cy=core.current;if(!cy)return;
    const visible=flow.nodes.filter(n=>n.day<=maxDay),ids=new Set(visible.map(n=>n.id));
    const edges=flow.edges.filter(e=>ids.has(e.from)&&ids.has(e.to));
    const signature=visible.map(n=>n.id).join('|');
    const ranks=new Map<number,FlowNode[]>();
    for(const n of visible){const rank=ranks.get(n.rank)??[];rank.push(n);ranks.set(n.rank,rank);}
    const desired=new Set([...ids,...edges.map(e=>e.id)]);
    cy.batch(()=>{
      cy.elements().filter(e=>!desired.has(e.id())).remove();
      for(const [rank,list] of ranks){
        list.sort((a,b)=>a.wallet.localeCompare(b.wallet)||a.id.localeCompare(b.id));
        for(let i=0;i<list.length;i++){
          const n=list[i],label=n.type==='holding'?`${name(n.wallet)} · day ${n.day}\n${fmt(n.amountSun)} TRX этой ставки`:
            `#${n.sequence} · day ${n.day}\n${fmt(n.amountSun)} доля / ${fmt(n.nativeSun!)} перевод`;
          const existing=cy.getElementById(n.id),data={...n,label};
          if(existing.length)existing.data(data);
          else cy.add({group:'nodes',data,position:{x:(i-(list.length-1)/2)*175,y:rank*98}});
        }
      }
      for(const e of edges){const existing=cy.getElementById(e.id),data={id:e.id,source:e.from,target:e.to,status:e.status,label:`${fmt(e.amountSun)} TRX${e.status==='HOLD'?' · остаётся на адресе':''}`};
        if(existing.length)existing.data(data);else cy.add({group:'edges',data});}
    });
    if(signature!==structure.current){cy.fit(cy.nodes(),25);structure.current=signature;}
  },[flow,maxDay,members]);
  function exportSvg(){
    const cy=core.current;if(!cy)return;
    const bound=cy.elements().boundingBox(),pad=50,width=Math.max(700,bound.w+pad*2),height=bound.h+pad*2+70+members.length*18;
    const x=(v:number)=>v-bound.x1+pad,y=(v:number)=>v-bound.y1+pad+42;
    const paths=cy.edges().map(edge=>{const a=edge.source().position(),b=edge.target().position(),color=edge.data('status')==='CONFIRMED'?'#167d81':edge.data('status')==='HOLD'?'#7b8896':'#789831';
      return `<path d="M ${x(a.x)} ${y(a.y)+32} C ${x(a.x)} ${(y(a.y)+y(b.y))/2} ${x(b.x)} ${(y(a.y)+y(b.y))/2} ${x(b.x)} ${y(b.y)-32}" fill="none" stroke="${color}" stroke-width="2" marker-end="url(#arrow)"${!['HOLD','CONFIRMED'].includes(edge.data('status'))?' stroke-dasharray="6 4"':''}/>`;}).join('');
    const nodes=cy.nodes().map(node=>{const p=node.position(),lines=String(node.data('label')).split('\n'),done=['INITIAL','CONFIRMED'].includes(node.data('status'));
      return `<g><rect x="${x(p.x)-73}" y="${y(p.y)-33}" width="146" height="66" rx="8" fill="${done?'#ecfaf8':'#f5f8e8'}" stroke="${done?'#167d81':'#789831'}"${!done?' stroke-dasharray="5 3"':''}/><text x="${x(p.x)}" y="${y(p.y)-4}" text-anchor="middle" font-size="11" fill="#183944">${lines.map((line,i)=>`<tspan x="${x(p.x)}" dy="${i?17:0}">${xml(line)}</tspan>`).join('')}</text></g>`;}).join('');
    const legend=members.map((m,i)=>`<text x="25" y="${height-members.length*18+i*18}" font-size="11">Node ${m.ordinal+1}: ${xml(m.address)}</text>`).join('');
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8Z" fill="#61778e"/></marker></defs><rect width="100%" height="100%" fill="white"/><g font-family="Arial,sans-serif"><text x="25" y="24" font-size="14">Stake: ${xml(owner)} · 1 TRX · up to day ${maxDay}</text><text x="25" y="43" font-size="11">Solid teal: confirmed · dashed green: planned · grey: retained holdings</text>${paths}${nodes}${legend}</g></svg>`;
    const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'})),link=document.createElement('a');
    link.href=url;link.download=`stake-${owner}-day-${maxDay}.svg`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  return <section className="ownership-flow"><div className="graph-tools"><button onClick={()=>core.current?.fit(undefined,25)}>Вписать схему</button><button onClick={()=>core.current?.zoom(core.current.zoom()*1.3)}>＋</button><button onClick={()=>core.current?.zoom(core.current.zoom()/1.3)}>−</button><button onClick={exportSvg}>Скачать схему SVG</button></div>
    <div ref={container} className="ownership-canvas" role="img" aria-label="Branching history and complete future plan of this original stake"/>
    <small>Стрелки идут от прошлого к будущему. Прямоугольник — остаток этой ставки на адресе; шестиугольник — реальный перевод. Серые линии показывают сохранение остатка. Можно приближать и перемещать схему.</small></section>;
}
