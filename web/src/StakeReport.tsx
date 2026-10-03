import {useEffect,useRef,useState} from 'react';
import {OwnershipFlow,type Flow} from './OwnershipFlow';
import type {Position} from './CampaignControls';

type Share={ownerAddress:string;amountSun:number};
type ReportEvent={id:string;sequence:number;kind:string;status:string;from:string;to:string;amountSun:number;ownerSun:number;
  campaignDay:number;plannedAt:string;scheduledAt:string;confirmedAt:string|null;bandwidthUsed:number|null;txId:string|null;
  allocations:Share[];fromComposition:Share[];toComposition:Share[]};
type Report={address:string;profile:{type:string;releaseDay:number;quarterDay:number;eighthDay:number|null};
  campaign:{id:string;status:string;totalDays:number;members:{address:string;ordinal:number}[]};events:ReportEvent[];
  positions:Position[];finalPositions:Position[];flow:Flow;cancelled:ReportEvent[];plannedMixSends:number};
const fmt=(sun:number)=>(sun/1_000_000).toFixed(6)+' TRX';
const when=(s:string)=>new Date(s).toLocaleString('en-GB',{timeZone:'Europe/Moscow',hour12:false})+' MSK';

export function StakeReport({address,revision}:{address:string;revision:string}){
  const [report,setReport]=useState<Report|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const [filter,setFilter]=useState('ALL'),[day,setDay]=useState(60),[selectedId,setSelectedId]=useState<string|null>(null);
  const [campaignId,setCampaignId]=useState(''),[archives,setArchives]=useState<{id:string;startedAt:string;status:string}[]>([]);
  const request=useRef(0);
  useEffect(()=>{setReport(null);setSelectedId(null);setDay(60);},[address,campaignId]);
  useEffect(()=>{void fetch('/api/campaigns',{cache:'no-store'}).then(r=>r.json()).then(setArchives).catch(()=>{});},[address]);
  useEffect(()=>{
    const id=++request.current;setLoading(true);setError('');
    void fetch(`/api/campaign/report/${encodeURIComponent(address)}${campaignId?'?campaignId='+encodeURIComponent(campaignId):''}`,{cache:'no-store'})
      .then(async r=>{const body=await r.json();if(!r.ok)throw Error(body.error??'Report unavailable');return body as Report;})
      .then(data=>{if(id===request.current){setReport(data);setDay(previous=>Math.min(previous,Math.max(data.campaign.totalDays,...data.events.map(e=>e.campaignDay))));}})
      .catch(e=>{if(id===request.current){setError(String(e));setReport(null);}})
      .finally(()=>{if(id===request.current)setLoading(false);});
    return()=>{request.current++;};
  },[address,revision,campaignId]);
  function selectCampaign(value:string){setCampaignId(value);setSelectedId(null);setDay(60);}
  if(!report)return <div className="stake-report"><select aria-label="Campaign archive" value={campaignId} onChange={e=>selectCampaign(e.target.value)}><option value="">Текущий план</option>{archives.map(a=><option key={a.id} value={a.id}>{when(a.startedAt)} · {a.status}</option>)}</select>
    {error&&<p className="history-intro">Для этого кошелька нет отчёта в выбранной кампании. История адреса доступна на соседней вкладке.<br/>{error}</p>}{loading&&<p>Загрузка плана…</p>}</div>;
  const name=(a:string)=>{const m=report.campaign.members.find(m=>m.address===a);return m?`Node ${m.ordinal+1}`:'Teacher';};
  const maxDay=Math.max(report.campaign.totalDays,...report.events.map(e=>e.campaignDay));
  const selected=report.events.find(e=>e.id===selectedId);
  const rows=report.events.filter(e=>filter==='ALL'||(filter==='CONFIRMED'?e.status==='CONFIRMED':e.status!=='CONFIRMED'));
  const composition=(shares:Share[])=>shares.map(a=>`${name(a.ownerAddress)}: ${fmt(a.amountSun)}`).join(' + ')||'0 TRX';
  return <div className="stake-report">
    <div className="report-toolbar"><select aria-label="Campaign archive" value={campaignId} onChange={e=>selectCampaign(e.target.value)}><option value="">Текущий план</option>{archives.map(a=><option key={a.id} value={a.id}>{when(a.startedAt)} · {a.status}</option>)}</select>
      <a className="report-download" href={`/api/campaign/report/${encodeURIComponent(address)}?format=csv&campaignId=${encodeURIComponent(report.campaign.id)}`}>Экспорт полного CSV</a>{loading&&<small>Обновление…</small>}</div>
    <p className="history-intro">Здесь движение исходного <b>1 TRX этого участника</b>, включая переводы между чужими адресами. Принадлежность долей задаёт сохранённый учёт кампании; в TRON монеты не имеют метки владельца. CSV содержит все будущие и подтверждённые шаги, полные адреса и состав переводов.</p>
    <div className="report-facts"><span>{report.events.length} шагов этой ставки</span><span>{report.flow.splits} разветвлений · {report.flow.merges} объединений</span><span>{report.plannedMixSends} MIX-отправок с адреса</span></div>
    <p className="history-intro">Профиль: {report.profile.type}. Допуск первого дробления — день {report.profile.releaseDay}; долей 0,25 — день {report.profile.quarterDay}{report.profile.eighthDay!==null?`; 0,125 — день ${report.profile.eighthDay}`:'; доли 0,125 для этого участника не используются'}. Фактические разветвления видны на схеме.</p>
    <div className="owner-positions"><b>Где находится этот 1 TRX по подтверждённым переводам:</b>{report.positions.length?report.positions.map(p=><span key={p.holderAddress}>{name(p.holderAddress)} · {fmt(p.amountSun)}<small>{p.holderAddress}</small></span>):<span>Ставка выплачена учителю.</span>}</div>
    <label className="report-day">Схема до дня {day} / {maxDay}<input type="range" min={0} max={maxDay} value={day} onChange={e=>setDay(Number(e.target.value))}/><button className="mini" onClick={()=>setDay(maxDay)}>Полная схема</button></label>
    <OwnershipFlow flow={report.flow} owner={address} members={report.campaign.members} maxDay={day}/>
    <div className="history-filters">{[['ALL','Полный план'],['CONFIRMED','Подтверждённые'],['PLANNED','Будущие']].map(([value,label])=><button key={value} className={filter===value?'active':''} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{label}</button>)}</div>
    <div className="report-table table-wrap"><table><thead><tr><th>День / №</th><th>Маршрут</th><th>Моя доля</th><th>Весь перевод</th><th>Время MSK</th><th>Статус</th></tr></thead><tbody>{rows.map(t=><tr key={t.id} className={selected?.id===t.id?'selected':''} onClick={()=>setSelectedId(t.id)} tabIndex={0} onKeyDown={e=>{if(e.key==='Enter')setSelectedId(t.id)}}>
      <td>{t.campaignDay} / #{t.sequence}<small>{t.kind}</small></td><td title={`${t.from} → ${t.to}`}>{name(t.from)} → {name(t.to)}</td><td>{fmt(t.ownerSun)}</td><td>{fmt(t.amountSun)}<small>{t.allocations.length} вкладов</small></td><td>{when(t.confirmedAt??t.scheduledAt)}<small>{t.confirmedAt?'Подтверждено':'Окно отправки; возможен сдвиг'}</small></td><td className="tag">{t.status}</td></tr>)}</tbody></table></div>
    {selected&&<section className="report-detail"><b>#{selected.sequence} · {name(selected.from)} → {name(selected.to)}</b><p className="full-address">{selected.from}<br/>→ {selected.to}</p>
      <p>Весь перевод: {fmt(selected.amountSun)}. Состав: {composition(selected.allocations)}.</p><p>После этого шага {name(selected.from)}: всего {fmt(selected.fromComposition.reduce((n,a)=>n+a.amountSun,0))} — {composition(selected.fromComposition)}.</p><p>После этого шага {name(selected.to)}: всего {fmt(selected.toComposition.reduce((n,a)=>n+a.amountSun,0))} — {composition(selected.toComposition)}.</p>
      <small>Это расчётный состав после выбранного шага полного плана. Подтверждённое текущее владение показано выше. Исходное время: {when(selected.plannedAt)}; текущее окно: {when(selected.scheduledAt)}.</small>
      {selected.txId&&<p className="full-address">TX: {selected.txId}</p>}{selected.bandwidthUsed!==null&&<small>Bandwidth всего перевода: {selected.bandwidthUsed}; распределение этой стоимости по долям не выдумывается.</small>}</section>}
    {report.cancelled.length>0&&<p className="history-intro">{report.cancelled.length} отменённых будущих шагов этой ставки сохранены в истории адресов и базе. Действующий CSV и схема используют подтверждённые шаги и актуальную карту возврата.</p>}
  </div>;
}
