// Run with a JSON file of observed messages. Default is a read-only preview.
process.env.TZ='Asia/Seoul';
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {reduceEvents}=require('./kakao-events.cjs');
const {app}=require('./headless-app.cjs');
function plan(remote,messages,now=new Date()) {
  reduceEvents(remote,messages,now); // Validate the full batch before any schedule changes.
  let state=structuredClone(remote); const result=[];
  state.kakaoAutomation=state.kakaoAutomation||{seen:{},watermarks:{}};
  for(const msg of [...messages].sort((a,b)=>Date.parse(a.postedAt)-Date.parse(b.postedAt))) {
    if(msg.kind!=='schedule') {const r=reduceEvents(state,[msg],now);state=r.state;result.push(...r.result);continue;}
    const meta=state.kakaoAutomation;
    // Validate schedule timestamps using the same strict input validator.
    reduceEvents(remote,[{...msg,text:''}],now);
    const hash=createHash('sha256').update(msg.postedAt+'\n'+msg.text).digest('hex');
    if(meta.seen[hash]||Date.parse(msg.postedAt)<=Date.parse(meta.scheduleAt||0)) continue;
    if(!/(?:PM|피엠)|에칭|데버링|화학동/i.test(msg.text)||/빽라이트|백라이트|진행\s*사항/.test(msg.text)) {
      result.push({type:'review',reason:'일정 공지 형식 불명확',postedAt:msg.postedAt});continue;
    }
    // Reuse the production app's notice parser, isolated from real Firebase/DOM.
    const a=app({now:msg.postedAt});
    a.context.remoteInput=structuredClone(state);
    a.run('acceptRemoteState(remoteInput); selectedDateStr=formatDateOnly(new Date());');
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
async function sync(messages,{apply=false,fetcher=fetch,now=new Date()}={}) {
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const url=html.match(/databaseURL:\s*"([^"]+)"/)[1]+'/pm_system_data.json';
  const auth=process.env.PM_FIREBASE_AUTH;
  const endpoint=auth?url+'?auth='+encodeURIComponent(auth):url;
  for(let attempt=0;attempt<3;attempt++) {
    const response=await fetcher(endpoint,{headers:{'X-Firebase-ETag':'true'},signal:AbortSignal.timeout(15000)});
    if(!response.ok) throw Error(`Firebase 읽기 실패 (${response.status}). 인증/기존 데이터 접근 권한을 확인하세요.`);
    const remote=await response.json();
    if(!remote||!Array.isArray(remote.chemList)) throw Error('기존 서버 데이터를 확인할 수 없어 반영을 중단합니다.');
    const {state,result}=plan(remote,messages,now);
    if(!apply||JSON.stringify(state)===JSON.stringify(remote)) return {applied:false,result};
    const etag=response.headers.get('etag');
    if(!etag) throw Error('동시 수정 보호용 ETag가 없어 반영을 중단합니다.');
    state.lastUpdated=now.toISOString();
    const written=await fetcher(endpoint,{method:'PUT',headers:{'Content-Type':'application/json','if-match':etag},body:JSON.stringify(state),signal:AbortSignal.timeout(15000)});
    if(written.status===412) continue;
    if(!written.ok) throw Error(`Firebase 저장 실패 (${written.status}).`);
    const confirmed=await written.json();
    if(JSON.stringify(confirmed.chemList)!==JSON.stringify(state.chemList)||JSON.stringify(confirmed.kakaoAutomation)!==JSON.stringify(state.kakaoAutomation)) throw Error('저장 결과 검증 실패');
    return {applied:true,result};
  }
  throw Error('동시 수정 충돌이 반복되어 다음 실행으로 연기합니다.');
}
if(require.main===module) {
  const file=process.argv[2];
  if(!file) {console.error('Usage: node automation/sync.cjs messages.json [--apply]');process.exitCode=1;}
  else {
    try {
      const messages=JSON.parse(fs.readFileSync(file,'utf8'));
      sync(messages,{apply:process.argv.includes('--apply')}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
    } catch(e) {console.error(e.message);process.exitCode=1;}
  }
}
module.exports={plan,sync};
