import {useEffect,useRef} from 'react';
import cytoscape from 'cytoscape';

export type GraphEdge={id:string;sequence:number;kind:string;status:string;from:string;to:string;amountSun:number;scheduledAt:string;txId:string|null;note:string|null;bandwidthUsed?:number|null;confirmedAt?:string|null;updatedAt?:string};
export type Graph={nodes:{id:string;label:string;mixEnabled:boolean;joined:boolean}[];edges:GraphEdge[];currentMapFromSequence?:number|null};
export type GraphMode='forecast'|'history'|'settlement'|'all';
export type RouteGroup={id:string;from:string;to:string;kind:string;phase:'confirmed'|'upcoming';count:number;totalSun:number;transfers:GraphEdge[]};
type Point={x:number;y:number};
const POSITION_KEY='trx-pool-node-positions-v1';

export function groupRoutes(graph:Graph,mode:GraphMode):RouteGroup[]{
  const routes=new Map<string,RouteGroup>();
  for(const transfer of graph.edges){
    if(transfer.status==='CANCELLED')continue;
    if(mode==='forecast'&&(transfer.kind!=='MIX'||transfer.status==='CONFIRMED'))continue;
    if(mode==='history'&&transfer.status!=='CONFIRMED')continue;
    if(mode==='settlement'&&(!['REBALANCE','PAYOUT'].includes(transfer.kind)||
      (graph.currentMapFromSequence!=null&&transfer.sequence<graph.currentMapFromSequence)))continue;
    const phase=transfer.status==='CONFIRMED'?'confirmed':'upcoming';
    const id=`route:${phase}:${transfer.kind}:${transfer.from}:${transfer.to}`;
    let route=routes.get(id);
    if(!route){
      route={id,from:transfer.from,to:transfer.to,kind:transfer.kind,phase,count:0,totalSun:0,transfers:[]};
      routes.set(id,route);
    }
    route.count++;
    route.totalSun+=transfer.amountSun;
    route.transfers.push(transfer);
  }
  return [...routes.values()].sort((a,b)=>a.transfers[0].sequence-b.transfers[0].sequence);
}

function defaultPositions(graph:Graph,width:number,height:number):Map<string,Point>{
  const cx=width/2,cy=height/2;
  const positions=new Map<string,Point>();
  const teacher=graph.nodes.find(n=>n.label==='Teacher');
  if(teacher)positions.set(teacher.id,{x:cx,y:cy});
  const active=graph.nodes.filter(n=>n!==teacher&&(n.mixEnabled||n.joined));
  const inactive=graph.nodes.filter(n=>n!==teacher&&!n.mixEnabled&&!n.joined);
  const outer=Math.min(width*.43,height*.42);
  const inner=Math.min(width*(active.length>8?.35:.25),height*(active.length>8?.36:.29));
  active.forEach((node,i)=>{
    // With two members, keep their edge clear of the teacher at the center.
    if(active.length===2)positions.set(node.id,{x:cx-inner*.8,y:cy+(i===0?-inner:inner)});
    else{
      const angle=-Math.PI/2+2*Math.PI*i/active.length;
      positions.set(node.id,{x:cx+inner*Math.cos(angle),y:cy+inner*Math.sin(angle)});
    }
  });
  inactive.forEach((node,i)=>{
    const angle=-Math.PI/2+2*Math.PI*i/inactive.length;
    positions.set(node.id,{x:cx+outer*Math.cos(angle),y:cy+outer*Math.sin(angle)});
  });
  return positions;
}

export function Network({graph,routes,selected,selectedRouteId,onSelect,onRouteSelect,layoutVersion}:{graph:Graph;routes:RouteGroup[];selected:string;selectedRouteId:string|null;onSelect:(address:string)=>void;onRouteSelect:(id:string)=>void;layoutVersion:number}){
  const el=useRef<HTMLDivElement>(null);
  const cy=useRef<cytoscape.Core|null>(null);
  const pinned=useRef(new Map<string,Point>());
  const lastReset=useRef(layoutVersion);

  useEffect(()=>{
    if(!el.current)return;
    try{
      const stored=JSON.parse(localStorage.getItem(POSITION_KEY)??'{}') as Record<string,Point>;
      for(const [id,p] of Object.entries(stored))if(Number.isFinite(p?.x)&&Number.isFinite(p?.y)&&Math.abs(p.x)<5&&Math.abs(p.y)<5)pinned.current.set(id,p);
    }catch{/* The graph still works if browser storage is unavailable. */}
    const instance=cytoscape({container:el.current,elements:[],layout:{name:'preset'},
      style:[
        {selector:'node',style:{'background-color':'#3d5365','border-width':2,'border-color':'#627787','width':34,'height':34,'label':'data(label)','font-size':12,'font-weight':'bold','font-family':'system-ui','color':'#e9f4fc','text-valign':'center','text-halign':'center'}},
        {selector:'node[?joined]',style:{'background-color':'#307e81','border-color':'#62d9d1'}},
        {selector:'node[?enabled]',style:{'background-color':'#5b7e41','border-color':'#b9f35a','border-width':4}},
        {selector:'node[?teacher]',style:{'background-color':'#a67532','border-color':'#f5bd66','width':42,'height':42,'shape':'diamond'}},
        {selector:'edge',style:{'width':'mapData(count,1,12,2.2,5)','line-color':'#b9f35a','target-arrow-color':'#b9f35a','target-arrow-shape':'triangle','arrow-scale':1.25,'curve-style':'bezier','opacity':.84,'line-style':'dashed'}},
        {selector:'edge[phase="confirmed"]',style:{'line-style':'solid','line-color':'#62d9d1','target-arrow-color':'#62d9d1'}},
        {selector:'edge[kind="REBALANCE"],edge[kind="PAYOUT"]',style:{'line-color':'#f5bd66','target-arrow-color':'#f5bd66'}},
        {selector:'edge:selected,edge.hover',style:{'opacity':1,'width':5,'label':'data(label)','font-size':11,'color':'#f1f8fe','text-background-color':'#102132','text-background-opacity':1,'text-background-padding':'5px','z-index':10}},
        {selector:'node:selected',style:{'border-color':'#fff','border-width':5}}
      ]});
    instance.on('tap','node',event=>onSelect(event.target.id()));
    instance.on('tap','edge',event=>onRouteSelect(event.target.id()));
    instance.on('mouseover','edge',event=>event.target.addClass('hover'));
    instance.on('mouseout','edge',event=>event.target.removeClass('hover'));
    instance.on('dragfree','node',event=>{
      if(!el.current)return;
      const p=event.target.position();
      pinned.current.set(event.target.id(),{x:p.x/el.current.clientWidth,y:p.y/el.current.clientHeight});
      try{localStorage.setItem(POSITION_KEY,JSON.stringify(Object.fromEntries(pinned.current)));}catch{/* Keep positions in memory. */}
    });
    cy.current=instance;
    return()=>{instance.destroy();cy.current=null;};
  },[onSelect,onRouteSelect]);

  useEffect(()=>{
    const instance=cy.current,container=el.current;
    if(!instance||!container||!graph.nodes.length)return;
    const reset=layoutVersion!==lastReset.current;
    if(reset){
      pinned.current.clear();
      try{localStorage.removeItem(POSITION_KEY);}catch{/* Browser storage is optional. */}
    }
    lastReset.current=layoutVersion;
    const fresh=instance.nodes().length===0;
    const width=container.clientWidth,height=container.clientHeight;
    const defaults=defaultPositions(graph,width,height);
    const wanted=new Set([...graph.nodes.map(n=>n.id),...routes.map(r=>r.id)]);
    instance.batch(()=>{
      instance.elements().filter(element=>!wanted.has(element.id())).remove();
      for(const node of graph.nodes){
        const data={id:node.id,label:node.label==='Teacher'?'T':node.label.replace('Node ',''),teacher:node.label==='Teacher',enabled:node.mixEnabled,joined:node.joined};
        const remembered=pinned.current.get(node.id);
        const position=remembered&&!reset?{x:remembered.x*width,y:remembered.y*height}:defaults.get(node.id)!;
        const element=instance.getElementById(node.id);
        if(element.length){
          element.data('label',data.label);element.data('enabled',data.enabled);element.data('joined',data.joined);
          if(!element.grabbed())element.position(position);
        }else instance.add({group:'nodes',data,position});
      }
      for(const route of routes){
        const label=`${(route.totalSun/1_000_000).toFixed(6)} TRX total · ${route.count} tx`;
        const element=instance.getElementById(route.id);
        if(element.length){element.data('count',route.count);element.data('label',label);}
        else instance.add({group:'edges',data:{id:route.id,source:route.from,target:route.to,kind:route.kind,phase:route.phase,count:route.count,label}});
      }
    });
    if(fresh||reset)instance.fit(instance.nodes(),40);
  },[graph,routes,layoutVersion]);

  useEffect(()=>{
    const instance=cy.current;
    if(!instance)return;
    instance.nodes().unselect();
    if(selected!=='all')instance.getElementById(selected).select();
  },[selected,graph]);

  useEffect(()=>{
    const instance=cy.current;
    if(!instance)return;
    instance.edges().unselect();
    if(selectedRouteId)instance.getElementById(selectedRouteId).select();
  },[selectedRouteId,routes]);

  return <div ref={el} className="graph" role="img" aria-label="Interactive transfer network; drag nodes to keep your layout"/>;
}
