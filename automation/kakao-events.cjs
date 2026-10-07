// Pure event reducer. No network calls and no raw conversations stored in state.
const {createHash} = require('node:crypto');
const IDS = new Set(['화7','화8','화9','화13','화14']);
function classify(text) {
  const tokens=[...text.matchAll(/(?:^|[^a-zA-Z0-9가-힣])((화학동|화|디화|디스미어|디|전기동|전|에칭|에)\s*(\d+))(?!\d)/gi)];
  return tokens.map((m,i)=>{
    if(!['화학동','화'].includes(m[2])||!IDS.has('화'+m[3])) return null;
    const segment=text.slice(m.index+(m[0].length-m[1].length),tokens[i+1]?.index??text.length);
    const body=segment.slice(m[1].length);
    if (/스웰러|망간|디스미어|설비\s*이상/.test(body)) return null;
    const pm=/(?:\bPM\b|피엠|피\s*엠)/i;
    const blocked=/미완료|미종료|예정|대기|확인\s*요청|아직|않|아님|아니|불가|취소|하면|할\s*경우|완료\s*후|종료\s*후/;
    const complete=/(?:PM|피\s*엠)\s*(?:후|완료|종료)|액\s*수위|양산\s*(?:진행|시작)/i.test(body);
    const running=pm.test(body)||(/PM\s*진행\s*사항/i.test(text)&&/세척|분석|공급|진행|작업/.test(body));
    const explicitTime=complete&&/\d{1,2}\s*시|\d{1,2}:\d{2}/.test(body);
    return {line:'화'+m[3],type:blocked.test(body)||explicitTime?'review':complete?'complete':running?'running':'ignore',segment};
  }).filter(Boolean);
}
function reduceEvents(state,messages,now=new Date()) {
  if (!Array.isArray(messages)||messages.length>1000) throw Error('메시지 배열은 최대 1000건입니다.');
  const next=structuredClone(state); const result=[];
  if (!Array.isArray(next.chemList)) throw Error('기존 화학동 데이터가 필요합니다.');
  next.kakaoAutomation=next.kakaoAutomation||{seen:{},watermarks:{}};
  const meta=next.kakaoAutomation;
  meta.seen=meta.seen||{}; meta.watermarks=meta.watermarks||{};
  const valid=messages.map(m=>{
    if (!m||typeof m.text!=='string'||m.text.length>20000||!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d)$/.test(m.postedAt||'')||!Number.isFinite(Date.parse(m.postedAt))) throw Error('본문과 시간대가 포함된 메시지 시각이 필요합니다.');
    if (Date.parse(m.postedAt)>now.getTime()+60000) throw Error('미래 메시지는 반영할 수 없습니다.');
    return m;
  }).sort((a,b)=>Date.parse(a.postedAt)-Date.parse(b.postedAt));
  for(const msg of valid) {
    const hash=createHash('sha256').update(msg.postedAt+'\n'+msg.text).digest('hex');
    if(meta.seen[hash]) continue;
    for(const event of classify(msg.text)) {
      const item=next.chemList.find(x=>x.id===event.line);
      if(!item||!IDS.has(item.id)||event.type==='ignore') continue;
      const at=Date.parse(msg.postedAt);
      const cutoff=Math.max(Date.parse(item.lastDone)||0,Date.parse(meta.watermarks[item.id])||0);
      if(at<=cutoff) {result.push({line:item.id,type:'stale'});continue;}
      if(event.type==='review') {result.push({line:item.id,type:'review',postedAt:msg.postedAt});continue;}
      if(event.type==='complete'&&item.status!=='시작') {result.push({line:item.id,type:'review',reason:'PM 진행 기록 없음',postedAt:msg.postedAt});continue;}
      meta.watermarks[item.id]=msg.postedAt;
      if(event.type==='running') {
        if(item.status==='시작') continue;
        item.previousCompletion=item.lastDone;
        item.status='시작'; item.lastDone=msg.postedAt;
        item.kakaoTimeBasis='최초 PM 관측 시각';
      } else {
        item.status='완료'; item.lastDone=msg.postedAt;
        item.kakaoTimeBasis='완료 신호 메시지 시각';
      }
      delete item.plannedDue;
      item.kakaoMessageHash=hash;
      result.push({line:item.id,type:event.type,postedAt:msg.postedAt});
    }
    meta.seen[hash]=msg.postedAt;
  }
  // Keep a bounded hash ledger; line watermarks protect against older replay.
  meta.seen=Object.fromEntries(Object.entries(meta.seen).sort((a,b)=>Date.parse(b[1])-Date.parse(a[1])).slice(0,2000));
  return {state:next,result};
}
module.exports={classify,reduceEvents};
