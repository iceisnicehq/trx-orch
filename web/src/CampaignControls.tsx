import {useState} from 'react';

export type Position={ownerAddress:string;holderAddress:string;amountSun:number};
export type Campaign={id:string;status:string;payAfterReturn:boolean;startedAt:string;deadlineAt:string;mixingDays:number;totalDays:number;
  total:number;confirmed:number;mixingTransfers:number;forecastEndsAt:string|null;deadlineRisk:boolean;positions:Position[];
  members:{address:string;ordinal:number;profile:{type:string;releaseDay:number;quarterDay:number;eighthDay:number|null}}[]};
export type Ask=(title:string,path:string,body?:object,description?:string)=>void;
const msk=(v:string)=>new Date(v).toLocaleString('en-GB',{timeZone:'Europe/Moscow',hour12:false})+' MSK';

export function CampaignControls({phase,selectedCount,teacherAddress,campaign,ask,legacyRebalance}:{phase:string;
  selectedCount:number;teacherAddress:string;campaign:Campaign|null;ask:Ask;legacyRebalance:()=>void}){
  const [days,setDays]=useState(36),[deadline,setDeadline]=useState(''),[teacher,setTeacher]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const canStart=['IDLE','MIXING','LEGACY_PAUSED','CAMPAIGN_RESTORED'].includes(phase);
  const canReturn=['CAMPAIGN','CAMPAIGN_RETURN_REQUESTED','CAMPAIGN_RETURNING'].includes(phase)&&!campaign?.payAfterReturn;
  function start(){
    setError('');
    if(!Number.isInteger(days)||days<18||days>60){setError('Выберите от 18 до 60 дней.');return;}
    const end=deadline?new Date(`${deadline}T23:59:00+03:00`):new Date(Date.now()+(days+6)*86_400_000);
    if(!Number.isFinite(end.getTime())){setError('Укажите корректную дату дедлайна.');return;}
    ask('Запустить полный план','/api/admin/start',{totalDays:days,deadlineAt:end.toISOString()},
      `План будет сохранён целиком: ${days-8} смешивающих отправок с каждого кошелька и до 8 дней на возврат долей. Состав участников фиксируется до завершения. Старые неотправленные маршруты и их одобрения отменяются. При выключенном Auto каждый перевод требует Approve.`);
  }
  async function returnEarly(){
    setBusy(true);setError('');
    try{
      const response=await fetch('/api/campaign/return/preview',{cache:'no-store'});
      const data=await response.json();if(!response.ok)throw Error(data.error??'Не удалось получить расчёт');
      ask(data.pendingReceipt?'Вернуть доли после подтверждения':'Вернуть исходные доли · '+data.transferCount+' переводов',
        '/api/admin/campaign/return',{},data.pendingReceipt?
          'Отправленная транзакция сначала получит подтверждение. Затем сервер рассчитает возврат по обновлённому учёту долей.':
          `Сейчас нужно ${data.transferCount} переводов. Консервативный бюджет — до ${data.estimatedDays} суток при восстановлении ресурсов и своевременных одобрениях. Будущий микс отменяется. Каждый получает свой учтённый 1 TRX; деньги учителю не отправляются. После возврата игра остановится, отчёт сохранится.`);
    }catch(e){setError(String(e));}finally{setBusy(false);}
  }
  return <section className="campaign-controls">
    <p>Полный план с разными датами дробления и объединением вкладов. Сначала одобряйте вручную; затем можно включить Auto для выбранных отправителей.</p>
    <div className="campaign-inputs"><label>Дней в плане<input type="number" min={18} max={60} value={days} disabled={!canStart} onChange={e=>setDays(Number(e.target.value))}/></label>
      <label>Дедлайн (конец дня, MSK)<input type="date" value={deadline} disabled={!canStart} onChange={e=>setDeadline(e.target.value)}/></label></div>
    <small className="amount-help">По умолчанию: 36 дней, из них 28 — микс, до 8 — возврат; дедлайн через 42 дня. Время отправок уточняется по подтверждениям и Bandwidth.</small>
    <div className="actions"><button disabled={!canStart||selectedCount<2} onClick={start}>▶ Полный план</button>
      {['MIXING','LEGACY_PAUSED'].includes(phase)&&<button className="rebalance" onClick={legacyRebalance}>⇄ Rebalance старой игры</button>}
      <button className="rebalance" disabled={!canReturn||busy} onClick={()=>void returnEarly()}>{busy?'Расчёт…':'⇄ Rebalance · вернуть доли'}</button>
      <button className="end" disabled={!['MIXING','LEGACY_PAUSED','REBALANCE_REQUESTED','REBALANCING','CAMPAIGN','CAMPAIGN_RETURN_REQUESTED','CAMPAIGN_RETURNING','CAMPAIGN_RESTORED'].includes(phase)}
        onClick={()=>ask('End game · выплаты учителю','/api/admin/end',{},'Сначала возвращаем каждому его учтённый 1 TRX, затем отправляем ровно 1 TRX с каждого вступившего кошелька текущему учителю. Возврат и выплаты требуют одобрения либо включённого Auto. Проверьте адрес учителя.')}>◆ End game</button></div>
    {phase==='LEGACY_PAUSED'&&<p className="campaign-warning">Старый режим остановлен. Если кошельки ещё не сбалансированы, выполните Rebalance. Затем выберите участников и запустите полный план.</p>}
    {campaign&&<div className="campaign-progress"><b>{campaign.confirmed} / {campaign.total} подтверждено</b>
      <small>По {campaign.mixingDays} MIX-отправок с каждого кошелька; возвраты считаются отдельно.</small>
      <small>Дедлайн: {msk(campaign.deadlineAt)}</small>{campaign.forecastEndsAt&&<small>Текущий прогноз завершения: {msk(campaign.forecastEndsAt)}</small>}
      {campaign.deadlineRisk&&<strong className="campaign-warning">Запас до дедлайна уменьшился. Движок готовит досрочный возврат; в ручном режиме нужны одобрения.</strong>}
    </div>}
    <div className="teacher-setting"><span className="eyebrow">АДРЕС УЧИТЕЛЯ</span><p className="full-address">{teacherAddress}</p>
      <label htmlFor="teacher-address">Новый полный адрес</label><input id="teacher-address" value={teacher} onChange={e=>setTeacher(e.target.value)} placeholder="T…" autoComplete="off" spellCheck={false}/>
      <button className="amount-save" disabled={!teacher.trim()||['END_REQUESTED','SETTLING'].includes(phase)} onClick={()=>ask('Изменить адрес учителя','/api/admin/teacher',{address:teacher.trim()},
        'Адрес проверяется на корректность и активацию. Смена сохраняется в базе и журнале; история остаётся. При незавершённых выплатах или неопределённой транзакции смена запрещена. Новый адрес сохранится после перезапуска даже с прежним wallets.json.')}>Изменить адрес учителя</button></div>
    {error&&<div className="error" role="alert">{error}</div>}
  </section>;
}
