// Pure local message planning. No network access or external writes.
process.env.TZ='Asia/Seoul';
const {createHash}=require('node:crypto');
const {reduceEvents}=require('./kakao-events.js');
const {app}=require('./headless-app.cjs');
function plan(initial,messages,now=new Date()) {
  reduceEvents(initial,messages,now); // Validate the full batch before any schedule changes.
  let state=structuredClone(initial); const result=[];
  state.kakaoAutomation=state.kakaoAutomation||{seen:{},watermarks:{}};
  for(const msg of [...messages].sort((a,b)=>Date.parse(a.postedAt)-Date.parse(b.postedAt))) {
    if(msg.kind!=='schedule') {const r=reduceEvents(state,[msg],now);state=r.state;result.push(...r.result);continue;}
    const meta=state.kakaoAutomation;
    // Validate schedule timestamps using the same strict input validator.
    reduceEvents(initial,[{...msg,text:''}],now);
    const hash=createHash('sha256').update(msg.postedAt+'\n'+msg.text).digest('hex');
    if(meta.seen[hash]||Date.parse(msg.postedAt)<=Date.parse(meta.scheduleAt||0)) continue;
    if(!/(?:PM|피엠)|에칭|데버링|화학동/i.test(msg.text)||/빽라이트|백라이트|진행\s*사항/.test(msg.text)) {
      result.push({type:'review',reason:'일정 공지 형식 불명확',postedAt:msg.postedAt});continue;
    }
    // Reuse the production app's notice parser, isolated from the real browser.
    const a=app({now:msg.postedAt});
    a.context.localInput=structuredClone(state);
    a.run('restoreLocalState(localInput); selectedDateStr=formatDateOnly(new Date());');
    a.parse(msg.text);
    const after=a.data('currentState()');
    for(const item of after.chemList) {
      const previous=state.chemList.find(x=>x.id===item.id);
      if(!previous) continue;
      if(Date.parse(msg.postedAt)<=Math.max(Date.parse(previous.lastDone)||0,Date.parse(meta.watermarks[item.id])||0)) {Object.assign(item,previous);continue;}
      // A schedule is never evidence that a PM started or finished.
      item.lastDone=previous.lastDone;item.status=previous.status;
    }
    for(const field of ['chemList','pulseList','manualNotes','equipWorkFlags','elecDummyFlags','pulseProcessFlags','elecCompletedFlags','inlineDesmearFlags']) state[field]=after[field];
    meta.scheduleAt=msg.postedAt;meta.seen[hash]=msg.postedAt;
    result.push({type:'schedule',postedAt:msg.postedAt});
  }
  return {state,result};
}
module.exports={plan};
