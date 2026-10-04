import {useEffect,useState} from 'react';
import type {Ask,Campaign} from './CampaignControls';
import {StakeReport} from './StakeReport';
type Range={min:number;max:number;mean:number;lower:number;upper:number};
type Owner={address:string;ordinal:number;steps:number;splits:number;merges:number;mixSends:number;returnSends:number;profile:{type:string;releaseDay:number;quarterDay:number;eighthDay:number|null}};
export type Variant={id:string;number:number;totalDays:number;deadlineAt:string;anchorAt:string;createdAt:string;parentId:string|null;generatorVersion:number;metrics:{owners:Owner[];steps:Range;splits:Range;merges:Range;balanced:boolean;total:number;mixingDays:number}};
export type Plans={canEdit:boolean;reason:string|null;selectedId:string|null;items:Variant[]};
const when=(s:string)=>new Date(s).toLocaleString('en-GB',{timeZone:'Europe/Moscow',hour12:false})+' MSK';
export function PlanManager({plans,campaign,phase,selectedCount,ask,revision}:{plans:Plans|null;campaign:Campaign|null;phase:string;selectedCount:number;ask:Ask;revision:string}){
  const [previewId,setPreviewId]=useState(''),[days,setDays]=useState(36),[deadline,setDeadline]=useState('');
  const [first,setFirst]=useState(''),[second,setSecond]=useState(''),[reportAddress,setReportAddress]=useState(''),[error,setError]=useState('');
  useEffect(()=>{setPreviewId(plans?.selectedId??'');setError('');},[plans?.selectedId]);
  const variant=plans?.items.find(v=>v.id===previewId),selected=plans?.items.find(v=>v.id===plans.selectedId);
  useEffect(()=>{setDays(selected?.totalDays??campaign?.totalDays??36);setDeadline('');},[selected?.id,campaign?.id]);
  useEffect(()=>{setFirst('');setSecond('');setReportAddress('');},[previewId]);
  const canEdit=Boolean(plans?.canEdit),preservedDeadline=selected?.deadlineAt??campaign?.deadlineAt;
  function generate(){
    setError('');if(!Number.isInteger(days)||days<18||days>60){setError('Укажите от 18 до 60 дней.');return;}
    const end=deadline?new Date(`${deadline}T23:59:00+03:00`):null;
    if(end&&!Number.isFinite(end.getTime())){setError('Некорректный дедлайн.');return;}
    ask('Сохранить новый вариант','/api/admin/plans/generate',{totalDays:days,...(end?{deadlineAt:end.toISOString()}: {})},
      'Новый вариант будет выбран для подготовки. Предыдущие сохраняются. Сервер проверит равномерность, сохранение каждой ставки и запас до дедлайна. До отдельного Start переводов и одобрений нет. Если текущий план ещё не исполнялся, его неотправленные одобрения отменяются.');
  }
  return <section className="panel plan-manager">
    <div className="section-head"><div><span className="eyebrow">ПОДГОТОВКА ПЕРЕД START</span><h2>Варианты полного плана</h2></div><span className="count">{plans?.items.length??0} сохранено</span></div>
    <p className="history-intro">Сгенерируйте варианты, сравните показатели и схемы, распределите роли и выберите один. Только Start запускает выбранный вариант. После начала подписания первого перевода генерация, выбор и обмен блокируются.</p>
    {!canEdit&&plans&&<p className="campaign-warning">Настройка заблокирована: {plans.reason}. Просмотр и экспорт остаются доступны.</p>}
    <div className="plan-prepare"><label>Дней в новом варианте<input type="number" min={18} max={60} value={days} disabled={!canEdit} onChange={e=>setDays(Number(e.target.value))}/></label><label>Изменить дедлайн (конец дня MSK)<input type="date" value={deadline} disabled={!canEdit} onChange={e=>setDeadline(e.target.value)}/></label>
      <button disabled={!canEdit||selectedCount<2} onClick={generate}>{plans?.items.length?'↻ Перегенерировать · сохранить вариант':'Создать первый вариант'}</button>
      {phase==='CAMPAIGN'&&canEdit&&<button onClick={()=>ask('Настроить текущий план','/api/admin/plans/current',{},'Текущий план сохраняется как вариант. Неотправленные одобрения отменяются; исполнение остановится до нового Start.')}>Настроить текущий план</button>}
    </div>
    <p className="amount-help">{preservedDeadline?`Пустой дедлайн сохраняет точное текущее значение: ${when(preservedDeadline)}.`:'Для первого плана пустой дедлайн означает длительность плана + 6 суток.'} Новый Start отсчитывает дни от запуска; дедлайн автоматически не переносится. Одобрения прежнего исполнения в варианты не копируются.</p>
    <div className="plan-prepare"><label>Просмотреть вариант<select value={previewId} onChange={e=>setPreviewId(e.target.value)}><option value="">Выберите вариант</option>{plans?.items.map(v=><option key={v.id} value={v.id}>#{v.number} · шаги {v.metrics.steps.min}–{v.metrics.steps.max} · ветви {v.metrics.splits.min}–{v.metrics.splits.max}{v.id===plans.selectedId?' · выбран':''}</option>)}</select></label>
      <button disabled={!canEdit||!variant||(phase==='PREPARING'&&variant.id===plans?.selectedId)} onClick={()=>variant&&ask(`Выбрать вариант #${variant.number}`,`/api/admin/plans/${variant.id}/select`,{},'Выбор восстановит состав участников этого варианта. Старый вариант сохраняется. Перед Start баланс и активация проверяются заново. Переводы пока не отправляются.')}>Выбрать для Start</button><b>{selected?`Выбран #${selected.number}${phase==='PREPARING'?' · ожидает Start':''}`:'Нет выбранного варианта'}</b></div>
    {variant&&<>
      <div className="report-facts"><span>Шаги ставки: {variant.metrics.steps.min}–{variant.metrics.steps.max}</span><span>Разветвления: {variant.metrics.splits.min}–{variant.metrics.splits.max}</span><span>{variant.metrics.total} реальных переводов</span><span>{variant.totalDays} дней · дедлайн {when(variant.deadlineAt)}</span></div>
      {!variant.metrics.balanced&&<p className="campaign-warning">Сохранённый прежний план не соответствует новым пределам равномерности. Он доступен как альтернатива; новые варианты проходят проверку.</p>}
      <p className="amount-help">Шаг — перевод, несущий часть исходной ставки игрока, включая отправки чужими адресами и возврат. Разветвление — уход части доли с сохранением остатка. Новые варианты: шаги около среднего ±10%, ветви ±20% (допуск минимум 2, округление до целых). Это отличается от числа отправок самого адреса.</p>
      <div className="plan-prepare"><label>Первый игрок<select disabled={!canEdit} value={first} onChange={e=>setFirst(e.target.value)}><option value="">Выберите</option>{variant.metrics.owners.map(o=><option key={o.address} value={o.address}>Node {o.ordinal+1}</option>)}</select></label><label>Второй игрок<select disabled={!canEdit} value={second} onChange={e=>setSecond(e.target.value)}><option value="">Выберите</option>{variant.metrics.owners.map(o=><option key={o.address} value={o.address}>Node {o.ordinal+1}</option>)}</select></label>
        <button disabled={!canEdit||!first||!second||first===second} onClick={()=>ask('Обменять роли игроков',`/api/admin/plans/${variant.id}/swap`,{first,second},'Создаётся и выбирается отдельный вариант с перестановкой маршрутов, владельцев долей и профилей. Исходный вариант сохраняется. Ключи, история и подтверждённые переводы не меняются.')}>⇄ Обменять планы · сохранить вариант</button></div>
      <div className="table-wrap plan-comparison"><table><thead><tr><th>Игрок</th><th>Шаги ставки</th><th>Ветви</th><th>Объединения</th><th>MIX с адреса</th><th>Возвраты с адреса</th><th>Дробление: дни 0,5 / 0,25 / 0,125</th><th>Отчёт</th></tr></thead><tbody>{variant.metrics.owners.map(o=><tr key={o.address}><td title={o.address}>Node {o.ordinal+1}</td><td>{o.steps}</td><td>{o.splits}</td><td>{o.merges}</td><td>{o.mixSends}</td><td>{o.returnSends}</td><td>{o.profile.releaseDay} / {o.profile.quarterDay} / {o.profile.eighthDay??'—'}</td><td><button className="mini" onClick={()=>setReportAddress(o.address)}>Схема / CSV</button></td></tr>)}</tbody></table></div>
    </>}{error&&<div className="error" role="alert">{error}</div>}
    {reportAddress&&variant&&<div className="overlay history-overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setReportAddress('')}} onKeyDown={e=>{if(e.key==='Escape')setReportAddress('')}}><section className="history-dialog" role="dialog" aria-modal="true" aria-label="Отчёт сохранённого варианта"><div className="section-head"><h2>Вариант #{variant.number} · Node {(variant.metrics.owners.find(o=>o.address===reportAddress)?.ordinal??0)+1}</h2><button className="history-close" autoFocus aria-label="Закрыть отчёт" onClick={()=>setReportAddress('')}>×</button></div><StakeReport address={reportAddress} revision={revision} variantId={variant.id}/></section></div>}
  </section>;
}
