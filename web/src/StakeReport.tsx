import {useEffect,useRef,useState} from 'react';
import {OwnershipFlow,type Flow} from './OwnershipFlow';
import type {Position} from './CampaignControls';
import {reportUrl,historyPreference,saveHistoryPreference} from './report-options';

type Share={ownerAddress:string;amountSun:number};
type ReportEvent={id:string;sequence:number;kind:string;status:string;from:string;to:string;amountSun:number;ownerSun:number|null;
  campaignDay?:number|null;plannedAt:string|null;scheduledAt:string;confirmedAt:string|null;updatedAt?:string;
  bandwidthUsed:number|null;txId:string|null;allocations:Share[];fromComposition:Share[]|null;toComposition:Share[]|null;
  reportSection?:'PREHISTORY';attributionBasis?:'UNRECORDED'|'RECORDED';legacyMode?:string};
type Member={address:string;ordinal:number};
type Report={address:string;profile:{type:string;releaseDay:number;quarterDay:number;eighthDay:number|null};
  campaign:{id:string;variantId?:string;status:string;totalDays:number;timingMode?:string;members:Member[]};events:ReportEvent[];
  prehistory:null|{enabled:boolean;events:ReportEvent[];wallets:Member[];unrecordedCount:number;notice:string};
  positions:Position[];finalPositions:Position[];flow:Flow;cancelled:ReportEvent[];plannedMixSends:number};
const fmt=(sun:number)=>(sun/1_000_000).toFixed(6)+' TRX';
const when=(s:string|null|undefined)=>s?new Date(s).toLocaleString('en-GB',{timeZone:'Europe/Moscow',hour12:false})+' MSK':'Не сохранено';

export function StakeReport({address,revision,variantId}:{address:string;revision:string;variantId?:string}){
  const [report,setReport]=useState<Report|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const [filter,setFilter]=useState('ALL'),[day,setDay]=useState(60),[selectedId,setSelectedId]=useState<string|null>(null);
  const [campaignId,setCampaignId]=useState(''),[archives,setArchives]=useState<{id:string;startedAt:string;status:string}[]>([]);
  const [includePrehistory,setIncludePrehistory]=useState(()=>historyPreference('graph'));
  const [includeCsvPrehistory,setIncludeCsvPrehistory]=useState(()=>historyPreference('csv'));
  const request=useRef(0);
  useEffect(()=>{setReport(null);setSelectedId(null);setDay(60);},[address,campaignId,variantId]);
  useEffect(()=>{void fetch('/api/campaigns',{cache:'no-store'}).then(r=>r.json()).then(setArchives).catch(()=>{});},[address]);
  useEffect(()=>{
    const id=++request.current,controller=new AbortController();setLoading(true);setError('');
    const timeout=setTimeout(()=>controller.abort(),20_000);
    void fetch(reportUrl({address,variantId,campaignId,includePrehistory}),{cache:'no-store',signal:controller.signal})
      .then(async r=>{const body=await r.json();if(!r.ok)throw Error(body.error??'Report unavailable');return body as Report;})
      .then(data=>{if(id===request.current){setReport(data);setDay(previous=>Math.min(previous,data.events.reduce((max,e)=>Math.max(max,e.campaignDay??0),data.campaign.totalDays)));}})
      .catch(e=>{if(id===request.current)setError(controller.signal.aborted?'Отчёт не ответил за 20 секунд. Повторите загрузку.':String(e));})
      .finally(()=>{clearTimeout(timeout);if(id===request.current)setLoading(false);});
    return()=>{request.current++;clearTimeout(timeout);controller.abort();};
  },[address,revision,campaignId,variantId,includePrehistory]);
  function selectCampaign(value:string){setCampaignId(value);setSelectedId(null);setDay(60);}
  const archiveSelect=!variantId&&<select aria-label="Campaign archive" value={campaignId} onChange={e=>selectCampaign(e.target.value)}><option value="">Текущий план</option>{archives.map(a=><option key={a.id} value={a.id}>{when(a.startedAt)} · {a.status}</option>)}</select>;
  const historyOptions=<div className="report-history-options">
    <label className="report-history-toggle"><input type="checkbox" checked={includePrehistory} onChange={e=>{
      setIncludePrehistory(e.target.checked);saveHistoryPreference('graph',e.target.checked);setSelectedId(null);
    }}/><span>Предыстория в схеме и таблице<small>Подтверждённые переводы до выбранного плана: RANDOM, LIST, Rebalance и прежние кампании.</small></span></label>
    <label className="report-history-toggle"><input type="checkbox" checked={includeCsvPrehistory} onChange={e=>{
      setIncludeCsvPrehistory(e.target.checked);saveHistoryPreference('csv',e.target.checked);
    }}/><span>Добавить предысторию в CSV<small>Независимо от переключателя схемы. Неизвестная доля владельца остаётся пустой.</small></span></label>
  </div>;
  if(!report)return <div className="stake-report">{archiveSelect}{historyOptions}
    {error&&<p className="history-intro">Для этого кошелька отчёт не загрузился. История адреса доступна на соседней вкладке.<br/>{error}</p>}{loading&&<p>Загрузка плана…</p>}</div>;
  const showPrehistory=includePrehistory&&Boolean(report.prehistory);
  const members=[...new Map([...(showPrehistory?report.prehistory!.wallets:[]),...report.campaign.members].map(m=>[m.address,m])).values()];
  const history=showPrehistory?report.prehistory!.events:[],allEvents=[...history,...report.events];
  // Hide an optional segment immediately, including while a replacement
  // response is loading. A slow/error response must not keep it visible.
  const rootRank=report.flow.nodes.find(n=>n.id==='root')?.rank??0;
  const flow=showPrehistory?report.flow:{...report.flow,
    nodes:report.flow.nodes.filter(n=>n.section!=='PREHISTORY').map(n=>({...n,rank:n.rank-rootRank})),
    edges:report.flow.edges.filter(e=>e.section!=='PREHISTORY')};
  const teacherAddresses=[...new Set(allEvents.filter(t=>t.kind==='PAYOUT').map(t=>t.to))];
  const name=(a:string)=>{const m=members.find(m=>m.address===a);return m?`Node ${m.ordinal+1}`:teacherAddresses.includes(a)?'Учитель':`${a.slice(0,5)}…${a.slice(-3)}`;};
  const maxDay=report.events.reduce((max,e)=>Math.max(max,e.campaignDay??0),report.campaign.totalDays);
  const selected=allEvents.find(e=>e.id===selectedId);
  const rows=allEvents.filter(e=>filter==='ALL'||(filter==='CONFIRMED'?e.status==='CONFIRMED':e.status!=='CONFIRMED'));
  const composition=(shares:Share[])=>shares.map(a=>`${name(a.ownerAddress)}: ${fmt(a.amountSun)}`).join(' + ')||'0 TRX';
  const csvUrl=reportUrl({address,variantId:report.campaign.variantId,campaignId:report.campaign.id,csv:true,includePrehistory:includeCsvPrehistory});
  return <div className="stake-report">
    <div className="report-toolbar">{archiveSelect}<a className="report-download" href={csvUrl}>{includeCsvPrehistory?'Экспорт CSV с предысторией':'Экспорт CSV плана'}</a>{loading&&<small>Обновление…</small>}</div>
    {error&&<p className="history-intro" role="alert">Не удалось обновить отчёт: {error}. Показаны последние загруженные данные.</p>}
    {historyOptions}
    {report.campaign.variantId&&<p className="campaign-warning">Предпросмотр сохранённого варианта. День 1 отсчитывается от будущего Start; показанные даты — ориентир генерации. Дедлайн остаётся фиксированным. DRAFT не является одобрением.</p>}
    <p className="history-intro">Здесь движение исходного <b>1 TRX этого участника</b> в выбранном плане, включая переводы между чужими адресами. Принадлежность долей задаёт сохранённый учёт кампании; в TRON монеты не имеют метки владельца.</p>
    {showPrehistory&&<div className="report-prehistory-notice"><b>{history.length} прежних подтверждённых переводов в связанной группе.</b>
      <p>{report.prehistory!.notice}</p>{!history.length&&<small>До выбранного плана связанных подтверждённых переводов в базе нет.</small>}
      {report.prehistory!.unrecordedCount>0&&<small>В {report.prehistory!.unrecordedCount} переводах доли владельцев не зафиксированы. Янтарная часть схемы показывает реальные суммы переводов и порядок операций; серые пунктирные связи показывают контекст.</small>}</div>}
    <div className="report-facts"><span>{report.events.length} шагов ставки в выбранном плане</span><span>{report.flow.splits} разветвлений · {report.flow.merges} объединений в плане</span><span>{report.plannedMixSends} MIX-отправок с адреса</span></div>
    <p className="history-intro">Профиль: {report.profile.type}. Допуск первого дробления — день {report.profile.releaseDay}; долей 0,25 — день {report.profile.quarterDay}{report.profile.eighthDay!==null?`; 0,125 — день ${report.profile.eighthDay}`:'; доли 0,125 для этого участника не используются'}. Фактические разветвления видны на схеме.</p>
    <div className="owner-positions"><b>Где находится этот 1 TRX по подтверждённому учёту выбранного плана:</b>{report.positions.length?report.positions.map(p=><span key={p.holderAddress}>{name(p.holderAddress)} · {fmt(p.amountSun)}<small>{p.holderAddress}</small></span>):<span>Ставка выплачена учителю.</span>}</div>
    <label className="report-day">Схема плана до дня {day} / {maxDay}<input type="range" min={0} max={maxDay} value={day} onChange={e=>setDay(Number(e.target.value))}/><button className="mini" onClick={()=>setDay(maxDay)}>Полная схема</button></label>
    <OwnershipFlow key={`${report.campaign.id}:${showPrehistory?'history':'plan'}`} flow={flow} owner={address} members={members} teacherAddresses={teacherAddresses} maxDay={day}/>
    <div className="history-filters">{[['ALL','Все показанные шаги'],['CONFIRMED','Подтверждённые'],['PLANNED','Будущие']].map(([value,label])=><button key={value} className={filter===value?'active':''} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{label}</button>)}</div>
    <div className="report-table table-wrap"><table><thead><tr><th>Этап / №</th><th>Маршрут</th><th>Моя доля</th><th>Весь перевод</th><th>Время MSK</th><th>Статус</th></tr></thead><tbody>{rows.map(t=><tr key={t.id} className={selected?.id===t.id?'selected':''} onClick={()=>setSelectedId(t.id)} tabIndex={0} onKeyDown={e=>{if(e.key==='Enter')setSelectedId(t.id)}}>
      <td>{t.reportSection==='PREHISTORY'?'До плана':t.campaignDay} / #{t.sequence}<small className={t.reportSection==='PREHISTORY'?'report-history-badge':''}>{t.legacyMode??t.kind}</small></td>
      <td title={`${t.from} → ${t.to}`}>{name(t.from)} → {name(t.to)}</td><td>{t.ownerSun===null?'Не зафиксирована':fmt(t.ownerSun)}</td>
      <td>{fmt(t.amountSun)}<small>{t.attributionBasis==='UNRECORDED'?'Состав не записывался':`${t.allocations.length} вкладов`}</small></td>
      <td>{when(t.confirmedAt??(t.status==='CONFIRMED'?t.updatedAt:undefined)??t.scheduledAt)}<small>{t.confirmedAt?'Подтверждено в блоке':t.status==='CONFIRMED'?'Время записи подтверждения':'Окно отправки; возможен сдвиг'}</small></td><td className="tag">{t.status}</td></tr>)}</tbody></table></div>
    {selected&&<section className="report-detail"><b>#{selected.sequence} · {name(selected.from)} → {name(selected.to)}</b><p className="full-address">{selected.from}<br/>→ {selected.to}</p>
      <p>Весь перевод: {fmt(selected.amountSun)}.{selected.attributionBasis==='UNRECORDED'?' Доля этого владельца и состав старого перевода не записывались.':` Состав: ${composition(selected.allocations)}.`}</p>
      {selected.fromComposition&&selected.toComposition?<>
        <p>После этого шага {name(selected.from)}: всего {fmt(selected.fromComposition.reduce((n,a)=>n+a.amountSun,0))} — {composition(selected.fromComposition)}.</p>
        <p>После этого шага {name(selected.to)}: всего {fmt(selected.toComposition.reduce((n,a)=>n+a.amountSun,0))} — {composition(selected.toComposition)}.</p>
        <small>Это расчётный состав после выбранного шага полного плана. Подтверждённое текущее владение показано выше.</small>
      </>:<small>Это фактический перевод из предыстории. Состав балансов после него здесь не восстанавливается; связь со SMART обозначает начало нового учёта.</small>}
      <small>Исходное время плана: {when(selected.plannedAt)}; сохранённое окно: {when(selected.scheduledAt)}.{selected.confirmedAt?` Подтверждение в блоке: ${when(selected.confirmedAt)}.`:selected.reportSection==='PREHISTORY'?` Запись подтверждения: ${when(selected.updatedAt)}.`:''}</small>
      {selected.txId&&<p className="full-address">TX: {selected.txId}</p>}{selected.bandwidthUsed!==null&&<small>Bandwidth всего перевода: {selected.bandwidthUsed}; стоимость по долям не распределяется.</small>}</section>}
    {report.campaign.timingMode==='BANDWIDTH'&&<p className="history-intro">Ускоренное расписание: день плана — этап алгоритма. Исходные даты сохранены; текущие даты показывают прогноз исполнения, подтверждённые — фактическое время. В CSV режим указан в timing_mode.</p>}
    {report.cancelled.length>0&&<p className="history-intro">{report.cancelled.length} отменённых будущих шагов этой ставки сохранены в истории адресов и базе. Действующий CSV и схема используют подтверждённые шаги и актуальную карту возврата.</p>}
  </div>;
}
