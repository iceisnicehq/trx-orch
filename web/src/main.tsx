import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Network,groupRoutes,type Graph,type GraphEdge,type GraphMode} from './Network';
import {CampaignControls,type Campaign} from './CampaignControls';
import {PlanManager,type Plans} from './PlanManager';
import {StakeReport} from './StakeReport';
import {RefreshGate,refreshSections,section,getJson as get} from './refresh';
import './style.css';

type Wallet={address:string;ordinal:number;autoApprove:boolean;mixEnabled:boolean;joined:boolean;reserveSun:number;balanceSun:number;bandwidth:number};
type State={mode:string;phase:string;status:string;fatalReason:string|null;teacherAddress:string;expectedPoolSun:number;poolSun:number;reserveSun:number;configuredSun:number;selectedCount:number;joinedCount:number;wallets:Wallet[];updatedAt:string;mixAmountMode:string;activeCampaignId:string|null;selectedPlanVariantId:string|null;mixAmountListSun:number[];mixAmountCursor:number;rebalanceTotal:number;rebalanceDone:number};
type RebalancePreview={pendingReceipt:boolean;transferCount:number|null;steps:{from:string;to:string;amountSun:number}[]};
type ExtraRecoveryPreview={eligible:boolean;reason:string|null;phase:string|null;extras:{address:string;sun:number}[];totalExtraSun:number;haltReason:string|null};
type Edge=GraphEdge;
type HistoryTransfer=GraphEdge & {createdAt:string;updatedAt:string};
type NodeHistory={address:string;total:number;items:HistoryTransfer[];nextBefore:number|null};
type HistoryStatus='CONFIRMED'|'ALL';
type Event={id:number;at:string;event:string;detail:string};
const fmt=(sun:number)=>`${(sun/1_000_000).toFixed(6)} TRX`;
const short=(s:string)=>s.length>20?`${s.slice(0,7)}…${s.slice(-6)}`:s;
const when=(v:string)=>new Date(v).toLocaleString();
const whenMSK=(v:string)=>`${new Date(v).toLocaleString('en-GB',{timeZone:'Europe/Moscow',hour12:false})} MSK`;
async function post(path:string,body:object){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw Error(j.error??`HTTP ${r.status}`);return j;}

function TransferChain({items,label,nodeLabel}:{items:GraphEdge[];label:string;nodeLabel:(address:string)=>string}){
  if(!items.length)return null;
  return <section className="transfer-chain" aria-label={label}>
    <span className="eyebrow">{label} · oldest → newest</span>
    <ol className="chain-steps">{[...items].reverse().map(t=><li key={t.id}>
      <small>#{t.sequence} · {t.kind}</small>
      <strong>{nodeLabel(t.from)} <span aria-hidden="true">→</span> {nodeLabel(t.to)}</strong>
      <span>{fmt(t.amountSun)}</span>
    </li>)}</ol>
  </section>;
}

function App(){
  const [state,setState]=useState<State|null>(null),[graph,setGraph]=useState<Graph>({nodes:[],edges:[]}),[queue,setQueue]=useState<Edge[]>([]);
  const [campaign,setCampaign]=useState<Campaign|null>(null);
  const [historyTab,setHistoryTab]=useState<'stake'|'address'>('address');
  const [graphMode,setGraphMode]=useState<GraphMode>('forecast'),[routeId,setRouteId]=useState<string|null>(null),[layoutVersion,setLayoutVersion]=useState(0);
  const [logs,setLogs]=useState<{events:Event[];transfers:Edge[]}>({events:[],transfers:[]}),[node,setNode]=useState('all'),[page,setPage]=useState(0);
  const [logStatus,setLogStatus]=useState<HistoryStatus>('CONFIRMED');
  const [error,setError]=useState(''),[modalError,setModalError]=useState(''),[modal,setModal]=useState<{title:string;path:string;body:object;description?:string}|null>(null),[password,setPassword]=useState(''),[working,setWorking]=useState(false);
  const [rebalancePreview,setRebalancePreview]=useState<RebalancePreview|null>(null),[previewWorking,setPreviewWorking]=useState(false);
  const [extraRecovery,setExtraRecovery]=useState<ExtraRecoveryPreview|null>(null),[recoveryWorking,setRecoveryWorking]=useState(false);
  const [historyAddress,setHistoryAddress]=useState<string|null>(null),[historyRows,setHistoryRows]=useState<HistoryTransfer[]>([]);
  const [historyStatus,setHistoryStatus]=useState<HistoryStatus>('CONFIRMED');
  const [historyNext,setHistoryNext]=useState<number|null>(null),[historyTotal,setHistoryTotal]=useState(0),[historyLoading,setHistoryLoading]=useState(false),[historyError,setHistoryError]=useState('');
  const [plans,setPlans]=useState<Plans|null>(null);
  const refreshId=useRef(0);
  const refreshGate=useRef(new RefreshGate());
  const refreshController=useRef<AbortController|null>(null);
  const historyRequestId=useRef(0);
  const priorPhase=useRef<string|null>(null);
  const refresh=useCallback(()=>refreshGate.current.run(async()=>{
    const id=++refreshId.current,controller=new AbortController();refreshController.current=controller;
    const current=()=>id===refreshId.current&&!controller.signal.aborted;
    const load=<T,>(path:string)=>get<T>(path,controller.signal);
    try{
      const failures=await refreshSections([
        section('State',()=>load<State>('/api/state'),setState),
        section('Graph',()=>load<Graph>('/api/graph'),setGraph),
        section('Queue',()=>load<Edge[]>('/api/queue'),setQueue),
        section('Logs',()=>load<{events:Event[];transfers:Edge[]}>(`/api/logs/${encodeURIComponent(node)}?page=${page}&status=${logStatus}`),setLogs),
        section('Campaign',()=>load<Campaign|null>('/api/campaign'),setCampaign),
        section('Plans',()=>load<Plans>('/api/plans'),setPlans)
      ],current);
      if(current())setError(previous=>failures.length?`Cannot refresh: ${failures.join('; ')}`:previous.startsWith('Cannot refresh:')?'':previous);
    }catch(e){if(current())setError(`Cannot refresh: ${String(e)}`);}
    finally{if(refreshController.current===controller)refreshController.current=null;}
  }),[node,page,logStatus]);
  useEffect(()=>{
    let stopped=false,timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{await refresh();if(!stopped)timer=setTimeout(()=>void poll(),5000);};
    void poll();
    return()=>{stopped=true;clearTimeout(timer);refreshId.current++;refreshController.current?.abort();};
  },[refresh]);
  useEffect(()=>{if(!state)return;const phase=state.phase;
    if(['END_REQUESTED','SETTLING','REBALANCE_REQUESTED','REBALANCING','CAMPAIGN_RETURN_REQUESTED','CAMPAIGN_RETURNING'].includes(phase)){setGraphMode('settlement');setRouteId(null);}
    else if(phase==='MIXING'&&['REBALANCE_REQUESTED','REBALANCING'].includes(priorPhase.current??'')){setGraphMode('forecast');setRouteId(null);}
    priorPhase.current=phase;
  },[state?.phase]);

  const choose=useCallback((v:string)=>{setNode(v);setPage(0);},[]);
  const loadHistory=useCallback(async(address:string,before?:number)=>{
    const request=++historyRequestId.current;
    setHistoryLoading(true);setHistoryError('');
    try{
      const result=await get<NodeHistory>(`/api/history/${encodeURIComponent(address)}?status=${historyStatus}${before===undefined?'':`&before=${before}`}`);
      if(request!==historyRequestId.current)return;
      setHistoryRows(previous=>before===undefined?result.items:[...previous,...result.items]);
      setHistoryNext(result.nextBefore);setHistoryTotal(result.total);
    }catch(e){if(request===historyRequestId.current)setHistoryError(`Cannot load node history: ${String(e)}`);}
    finally{if(request===historyRequestId.current)setHistoryLoading(false);}
  },[historyStatus]);
  useEffect(()=>{if(historyAddress){setHistoryRows([]);setHistoryNext(null);setHistoryTotal(0);void loadHistory(historyAddress);}
    return()=>{historyRequestId.current++;};
  },[historyAddress,loadHistory]);
  const chooseNode=useCallback((address:string)=>{choose(address);setHistoryStatus('CONFIRMED');setHistoryAddress(address);setHistoryTab('stake');},[choose]);
  const pending=useMemo(()=>queue.filter(q=>q.status==='PLANNED'),[queue]);
  const routes=useMemo(()=>groupRoutes(graph,graphMode),[graph,graphMode]);
  const visibleTransferCount=routes.reduce((sum,route)=>sum+route.count,0);
  const visibleVolumeSun=routes.reduce((sum,route)=>sum+route.totalSun,0);
  const recentConfirmed=useMemo(()=>graph.edges.filter(t=>t.status==='CONFIRMED').sort((a,b)=>b.sequence-a.sequence).slice(0,6),[graph]);
  const nodeConfirmed=historyRows.filter(t=>t.status==='CONFIRMED').slice(0,6);
  const selectedRoute=routes.find(route=>route.id===routeId);
  const nodeLabel=(address:string)=>graph.nodes.find(n=>n.id===address)?.label??short(address);
  function ask(title:string,path:string,body:object={},description?:string){setPassword('');setModalError('');setModal({title,path,body,description});setError('');}
  async function previewRebalance(){setPreviewWorking(true);setError('');try{const result=await get<RebalancePreview>('/api/rebalance/preview');setRebalancePreview(result);
    ask(result.pendingReceipt?'Rebalance after the pending receipt':`Rebalance · ${result.transferCount} transfer${result.transferCount===1?'':'s'}`,'/api/admin/rebalance');
  }catch(e){setError(`Cannot preview rebalance: ${String(e)}`);}finally{setPreviewWorking(false);}}
  async function previewExtraRecovery(){setRecoveryWorking(true);setError('');try{
    const result=await get<ExtraRecoveryPreview>('/api/recovery/preview');setExtraRecovery(result);
    if(!result.eligible){setError(`Resume unavailable: ${result.reason}`);return;}
    ask(`Review and resume ${result.phase}`,'/api/admin/resume');
  }catch(e){setError(`Cannot review halted game: ${String(e)}`);}finally{setRecoveryWorking(false);}}
  async function submit(e:React.FormEvent){e.preventDefault();if(!modal)return;setWorking(true);
    try{await post(modal.path,{...modal.body,password});setPassword('');setModalError('');setModal(null);setError('');await refresh();}
    catch(e){setModalError(String(e));}finally{setWorking(false);}
  }
  return <div className="app">
    <header className="top"><div className="brand"><span className="brandmark">◈</span><div><b>TRX POOL</b><small>OBSERVATORY / {state?.mode.toUpperCase()??'CONNECTING'}</small></div></div><div className="right"><span className={'pill '+(state?.phase==='HALTED'?'bad':['MIXING','REBALANCING','REBALANCE_REQUESTED','CAMPAIGN','CAMPAIGN_RETURNING'].includes(state?.phase??'')?'running':'')}>{state?.phase??'CONNECTING'}</span><span className="updated">Updated {state?when(state.updatedAt):'—'}</span></div></header>
    <main><div className={'status '+(state?.phase==='HALTED'?'danger':'')}><span className="pulse"/><strong>{state?.status??(error?'Status: API request failed; retrying…':'Status: connecting…')}</strong></div>
      {error&&<div className="error" role="alert">{error}</div>}
      {state&&['REBALANCE_REQUESTED','REBALANCING'].includes(state.phase)&&<div className="rebalance-progress" role="status">{state.phase==='REBALANCE_REQUESTED'?'Rebalance: waiting for an in-flight transfer to finish.':`Rebalance: ${state.rebalanceDone} of ${state.rebalanceTotal} transfers confirmed.`} Remaining steps appear in the queue and settlement map.</div>}
      <div className="metrics">
        <div className="metric"><span>GAME STAKE</span><b>{state?fmt(state.poolSun):'—'}</b><small>Expected {state?fmt(state.expectedPoolSun):'—'}</small><small>Across all 17 slots: {state?fmt(state.configuredSun):'—'}</small></div>
        <div className="metric"><span>PARTICIPANTS</span><b>{state?`${state.phase==='IDLE'?state.selectedCount:state.joinedCount} / ${state.wallets.length}`:'—'}</b><small>{state?.selectedCount??0} enabled for mixing · {state?.joinedCount??0} joined</small><small>{state?.reserveSun??0} extra Sun excluded</small></div>
        <div className="metric"><span>AWAITING APPROVAL</span><b>{pending.length}</b><small>Ordered execution queue</small></div>
        <div className="metric"><span>TRANSACTIONS</span><b>{graph.edges.filter(e=>e.status==='CONFIRMED').length}</b><small>Confirmed and zero-fee</small></div>
      </div>
      <div className="main-grid"><section className="panel graphpanel"><div className="section-head"><div><span className="eyebrow">NETWORK MAP</span><h2>Transfer flow</h2></div><div className="legend"><span><i className="hist"/>Executed</span><span><i className="plan"/>Planned</span><span><i className="settle"/>Settlement</span></div></div>
        <div className="graph-tools" role="group" aria-label="Graph transfer filter">{([['forecast','Upcoming'],['history','Executed'],['settlement','Settlement'],['all','All']] as const).map(([mode,label])=><button key={mode} className={graphMode===mode?'active':''} aria-pressed={graphMode===mode} onClick={()=>{setGraphMode(mode);setRouteId(null)}}>{label}</button>)}</div>
        <Network graph={graph} routes={routes} selected={node} selectedRouteId={selectedRoute?.id??null} onSelect={chooseNode} onRouteSelect={setRouteId} layoutVersion={layoutVersion}/>
        <div className="graph-summary"><span>{visibleTransferCount} {visibleTransferCount===1?'transfer':'transfers'} on {routes.length} {routes.length===1?'route':'routes'} · {fmt(visibleVolumeSun)} total · numbered circles are wallets · T is the teacher</span><button onClick={()=>{setLayoutVersion(v=>v+1);setRouteId(null)}}>Reset layout</button></div>
        <div className="route-list" aria-label="Visible transfer routes">{routes.length?routes.map(route=><button key={route.id} className={selectedRoute?.id===route.id?'active':''} onClick={()=>setRouteId(route.id)}>{nodeLabel(route.from)} → {nodeLabel(route.to)} <b>{fmt(route.totalSun)} · {route.count} tx</b></button>):<span>No transfers in this view.</span>}</div>
        <TransferChain items={recentConfirmed} label="Recent confirmed transfers" nodeLabel={nodeLabel}/>
        {selectedRoute?<div className="route-detail"><strong>{nodeLabel(selectedRoute.from)} → {nodeLabel(selectedRoute.to)} · {selectedRoute.kind} · {fmt(selectedRoute.totalSun)} total</strong><div className="route-rows">{selectedRoute.transfers.map(t=><span key={t.id}>#{t.sequence} · {fmt(t.amountSun)} · {t.status} · {when(t.scheduledAt)}</span>)}</div></div>:<p className="hint">Select a line or route for individual transfers. Click a wallet to open its complete transfer history. Drag wallets to rearrange them; their positions stay in this browser.</p>}</section>
        <aside className="panel controls">
          <span className="eyebrow">CONTROL ROOM</span><h2>Game controls</h2>
          <CampaignControls phase={state?.phase??'CONNECTING'} selectedCount={state?.selectedCount??0} teacherAddress={state?.teacherAddress??''} campaign={campaign} ask={ask} legacyRebalance={()=>void previewRebalance()}/>
          {state?.phase==='HALTED'&&<div className="halted-recovery"><strong>Game halted</strong><p>Check participant balances and confirmed transfers before resuming. Independent changes to the teacher wallet no longer stop the game; deficits, fees and uncertain transfers remain blocked.</p><button onClick={()=>void previewExtraRecovery()} disabled={recoveryWorking}>{recoveryWorking?'Checking balances…':'Review and resume game'}</button></div>}
          <div className="divider"/><div className="section-head"><div><span className="eyebrow">WALLETS</span><h3>Mix / autoapprove</h3></div><div className="wallet-heads"><span>Mix</span><span>Auto</span></div></div>
          <div className="wallets">{state?.wallets.map(w=><div className="wallet" key={w.address}>
            <div className="wallet-info"><strong>Node {w.ordinal+1} <button className="history-link" onClick={()=>chooseNode(w.address)} aria-label={`View complete transfer history for node ${w.ordinal+1}`}>History</button></strong><small title={w.address}>{short(w.address)} · {fmt(w.balanceSun)}</small>
              <small>{w.bandwidth} free bandwidth (chain snapshot) · {w.joined?(w.mixEnabled&&['MIXING','CAMPAIGN'].includes(state.phase)?'Joined, mixing':'Joined, mixing paused'):(w.mixEnabled?'Selected, awaiting join':'Outside game')}</small>
              {campaign&&campaign.members.some(m=>m.address===w.address)&&<small className="wallet-ownership">Учёт подтверждённых долей: {campaign.positions.filter(p=>p.holderAddress===w.address).map(p=>`${nodeLabel(p.ownerAddress)} ${fmt(p.amountSun)}`).join(' + ')||'0 TRX'}</small>}
              {w.reserveSun>0&&<small>{w.reserveSun} extra Sun {w.joined?'reserved':'outside the 1 TRX stake'}</small>}
            </div>
            <div className="wallet-controls">
              <button className={'mix-check '+(w.mixEnabled?'on':'')} role="checkbox" aria-checked={w.mixEnabled} aria-label={`Include node ${w.ordinal+1} in mixing`} disabled={!state||!['IDLE','MIXING','LEGACY_PAUSED','CAMPAIGN_RESTORED','PREPARING'].includes(state.phase)} onClick={()=>ask(`${w.mixEnabled?'Pause mixing for':'Include'} node ${w.ordinal+1}`,`/api/admin/wallets/${w.address}/mix-enabled`,{enabled:!w.mixEnabled})}>{w.mixEnabled?'✓':''}</button>
              <button className={'toggle '+(w.autoApprove?'on':'')} role="switch" aria-checked={w.autoApprove} aria-label={`Autoapprove node ${w.ordinal+1}`} onClick={()=>ask(`${w.autoApprove?'Disable':'Enable'} autoapproval for node ${w.ordinal+1}`,`/api/admin/wallets/${w.address}/autoapprove`,{enabled:!w.autoApprove})}><span/></button>
            </div>
          </div>)}</div>
        </aside></div>
      <PlanManager plans={plans} campaign={campaign} phase={state?.phase??'CONNECTING'} selectedCount={state?.selectedCount??0} ask={ask} revision={state?.updatedAt??''}/>
      <div className="bottom-grid"><section className="panel"><div className="section-head"><div><span className="eyebrow">REVIEW DESK</span><h2>Transaction queue</h2></div><span className="count">{queue.length} nearest</span></div><p className="history-intro">Ближайшая незавершённая отправка каждого участника. DRAFT — только предпросмотр: сначала Start, затем одобрение. Полное будущее движение ставки доступно по клику на Node → «Мой 1 TRX».</p><div className="table-wrap"><table><thead><tr><th>SEQ / TYPE</th><th>ROUTE</th><th>AMOUNT</th><th>SCHEDULE</th><th>STATE</th><th></th></tr></thead><tbody>{queue.length?queue.map(q=><tr key={q.id}><td><b>#{q.sequence}</b><small>{q.kind}{q.campaignDay?` · day ${q.campaignDay}`:''}</small></td><td className="route" title={`${q.from} → ${q.to}`}>{short(q.from)} → {short(q.to)}</td><td>{fmt(q.amountSun)}</td><td title={when(q.scheduledAt)}>{q.status==='DRAFT'?'После Start · day '+q.campaignDay:new Date(q.scheduledAt).getTime()<=Date.now()?'Due now':when(q.scheduledAt)}</td><td><span className={'tag '+q.status.toLowerCase()}>{q.status}</span>{q.note&&<small className="queue-note" title={q.note}>{q.note}</small>}</td><td>{q.status==='PLANNED'&&<button className="mini" onClick={()=>ask(`Approve #${q.sequence} · ${fmt(q.amountSun)}`,`/api/admin/queue/${q.id}/approve`)}>Approve</button>}</td></tr>):<tr><td colSpan={6} className="empty">No transfers awaiting execution.</td></tr>}</tbody></table></div></section>
      <section className="panel"><div className="section-head"><div><span className="eyebrow">PUBLIC AUDIT</span><h2>Node history</h2></div><select aria-label="Filter logs by node" value={node} onChange={e=>choose(e.target.value)}><option value="all">All nodes</option>{state?.wallets.map(w=><option key={w.address} value={w.address}>Node {w.ordinal+1}</option>)}{state&&<option value={state.teacherAddress}>Teacher</option>}</select></div><div className="history-filters" role="group" aria-label="Filter public transfer log">{(['CONFIRMED','ALL'] as const).map(status=><button key={status} type="button" aria-pressed={logStatus===status} className={logStatus===status?'active':''} onClick={()=>{setLogStatus(status);setPage(0);setLogs(previous=>({...previous,transfers:[]}));}}>{status==='CONFIRMED'?'Confirmed':'All'}</button>)}</div><div className="loglist">{logs.transfers.length?logs.transfers.map(t=><div className="log" key={t.id}><span className={'dot '+(t.status==='CONFIRMED'?'done':'')}/><div><b>{t.kind} · {fmt(t.amountSun)}</b><small>{short(t.from)} → {short(t.to)} · {t.status}</small>{t.status==='CONFIRMED'&&<small>{t.bandwidthUsed===null||t.bandwidthUsed===undefined?'Bandwidth unavailable from receipt':`${t.bandwidthUsed} Bandwidth used`} · 0 Sun fee</small>}{t.txId&&<small title={t.txId}>TX {short(t.txId)}</small>}</div><time>{when(t.confirmedAt??t.updatedAt??t.scheduledAt)}</time></div>):<p className="empty">{logStatus==='CONFIRMED'?'No confirmed transfers in this view.':'No transfers recorded.'}</p>}{logs.events.length>0&&<><h3 className="audit-title">System events</h3>{logs.events.map(e=><div className="event" key={e.id}><b>{e.event}</b><span>{e.detail}</span><time>{when(e.at)}</time></div>)}</>}</div><div className="pager"><button disabled={page===0} onClick={()=>setPage(page-1)}>Previous</button><span>Page {page+1}</span><button disabled={logs.transfers.length<100&&logs.events.length<100} onClick={()=>setPage(page+1)}>Next</button></div></section></div>
      <footer>Pool conservation is verified against the chain before each transfer. Broadcasting pauses when free bandwidth or receipt certainty is insufficient.</footer>
    </main>
    {historyAddress&&<div className="overlay history-overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setHistoryAddress(null)}} onKeyDown={e=>{if(e.key==='Escape')setHistoryAddress(null)}}><section className="history-dialog" role="dialog" aria-modal="true" aria-label={`${nodeLabel(historyAddress)} transfer history`}>
      <div className="section-head"><div><span className="eyebrow">NODE TRANSFER HISTORY</span><h2>{nodeLabel(historyAddress)} · {historyTab==='stake'?'исходный 1 TRX':`${historyTotal} ${historyStatus==='CONFIRMED'?'confirmed':'total'} records`}</h2></div><button className="history-close" aria-label="Close history" autoFocus onClick={()=>setHistoryAddress(null)}>×</button></div>
      <p className="history-address">{historyAddress}</p>
      <div className="history-filters" role="tablist" aria-label="Wallet report view"><button role="tab" aria-selected={historyTab==='stake'} className={historyTab==='stake'?'active':''} onClick={()=>setHistoryTab('stake')}>Мой 1 TRX · полный план</button><button role="tab" aria-selected={historyTab==='address'} className={historyTab==='address'?'active':''} onClick={()=>setHistoryTab('address')}>История адреса</button></div>
      {historyTab==='stake'?<StakeReport address={historyAddress} revision={state?.updatedAt??''}/>:<>
<p className="history-intro">Confirmed transfers are shown first. All includes open and cancelled plans. Times are Moscow (MSK); Load older pages through the selected view.</p>
      <div className="history-filters" role="group" aria-label="Filter node transfer history">{(['CONFIRMED','ALL'] as const).map(status=><button key={status} type="button" aria-pressed={historyStatus===status} className={historyStatus===status?'active':''} onClick={()=>setHistoryStatus(status)}>{status==='CONFIRMED'?'Confirmed':'All'}</button>)}</div>
      {historyError&&<div className="error" role="alert">{historyError}</div>}
      <TransferChain items={nodeConfirmed} label={`Recent confirmed flow for ${nodeLabel(historyAddress)}`} nodeLabel={nodeLabel}/>
      <div className="history-records" role="list">{historyRows.map(t=><div className="history-record" role="listitem" key={t.id}>
        <div className="history-record-title"><b>#{t.sequence} · {t.from===historyAddress?'OUT':'IN'} · {t.kind}</b><span className={'tag '+t.status.toLowerCase()}>{t.status}</span></div>
        <strong>{nodeLabel(t.from)} → {nodeLabel(t.to)} · {fmt(t.amountSun)}</strong>
        <small title={`${t.from} → ${t.to}`}>{t.from} → {t.to}</small>
        <small>{t.confirmedAt?'Confirmed':t.status==='CANCELLED'?'Cancelled / updated':'Last updated'}: {whenMSK(t.confirmedAt??t.updatedAt)} · Scheduled: {whenMSK(t.scheduledAt)}</small>
        {t.status==='CONFIRMED'&&<small>{t.bandwidthUsed==null?'Bandwidth unavailable from receipt':`${t.bandwidthUsed} Bandwidth used`} · 0 Sun fee</small>}
        {t.txId&&<small className="history-tx">TX: {t.txId}</small>}{t.note&&<small>{t.note}</small>}
      </div>)}{!historyLoading&&!historyRows.length&&!historyError&&<p className="empty">{historyStatus==='CONFIRMED'?'No confirmed transfers for this node.':'No transfers recorded for this node.'}</p>}</div>
      <div className="history-actions"><span>{historyRows.length} of {historyTotal} shown</span><button disabled={historyLoading} onClick={()=>void loadHistory(historyAddress)}>Refresh</button>{historyNext!==null&&<button disabled={historyLoading} onClick={()=>void loadHistory(historyAddress,historyNext)}>Load older</button>}{historyLoading&&<span>Loading…</span>}</div></>}

    </section></div>}
    {modal&&<div className="overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setModal(null)}}><form className="dialog" onSubmit={submit}><span className="eyebrow">ADMIN AUTHORIZATION</span><h2>{modal.title}</h2><p>{modal.description??(modal.path==='/api/admin/replan'?'This cancels pending MIX transfers, including approved ones, then creates a fresh queue. Confirmed transfers stay in the audit log.':modal.path==='/api/admin/mix-amounts'?'Saving cancels unsent MIX transfers and their approvals. New rows follow the chosen amount mode; a transfer already in flight must first be confirmed.':modal.path==='/api/admin/rebalance'?'The count below is a preview from current confirmed chain balances. Unsent MIX and their approvals are cancelled. A submitted MIX finishes first, so the final count may change. Rebalance steps require Approve unless each sender has Auto enabled. The old mixer remains paused after restoration; you can start the new campaign.':modal.path==='/api/admin/resume'?'Participant balances and the confirmed transfer ledger will be checked again. Positive surplus is reserved to its wallet. Existing transfers and approvals remain. Already approved transfers, including End payouts, may execute as soon as the engine resumes.':'This action changes the transaction engine. Enter the admin password to continue.')}</p>{modal.path==='/api/admin/rebalance'&&rebalancePreview&&<div className="preview-details"><strong>{rebalancePreview.pendingReceipt?'Exact transfer count will be known after the pending receipt.':`${rebalancePreview.transferCount} internal transfer${rebalancePreview.transferCount===1?'':'s'} to restore each joined wallet to 1 TRX plus its protected extra Sun.`}</strong>{rebalancePreview.steps.length>0&&<div className="preview-steps">{rebalancePreview.steps.map((step,index)=><span key={`${index}-${step.from}`}>{index+1}. {short(step.from)} → {short(step.to)} · {fmt(step.amountSun)}</span>)}</div>}</div>}{modal.path==='/api/admin/resume'&&extraRecovery&&<div className="preview-details"><strong>Previous halt: {extraRecovery.haltReason}. Resume {extraRecovery.phase}; reserve {extraRecovery.totalExtraSun} extra Sun.</strong><div className="preview-steps">{extraRecovery.extras.map(w=><span key={w.address}>{nodeLabel(w.address)} ({short(w.address)}): +{w.sun} Sun reserved</span>)}{!extraRecovery.extras.length&&<span>No new extra Sun; participant balances match the recorded transfers.</span>}</div></div>}{modalError&&<div className="error" role="alert">{modalError}</div>}<label htmlFor="password">Password</label><input id="password" type="password" autoComplete="off" autoFocus required value={password} onChange={e=>setPassword(e.target.value)}/><div className="dialog-actions"><button type="button" className="cancel" onClick={()=>setModal(null)}>Cancel</button><button type="submit" disabled={working}>{working?'Working…':'Confirm'}</button></div></form></div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
