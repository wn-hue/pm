const {test}=require('node:test');
const assert=require('node:assert/strict');
const {reduceEvents,classify}=require('../automation/kakao-events.cjs');
const {sync,plan}=require('../automation/sync.cjs');
const state=()=>({chemList:['화7','화8','화9','화13','화14'].map(id=>({id,lastDone:'2026-10-01T10:00:00+09:00',status:'완료',note:''})),unrelated:{preserve:true}});
const msg=(time,text,kind)=>({postedAt:`2026-10-07T${time}:00+09:00`,text,kind});
const now=new Date('2026-10-07T23:00:00+09:00');
test('backlight starts only PM lines, repeated observations keep first time; completion restarts 72h',()=>{
 const input=[msg('10:05','10시 빽라이트\n화7 D10\n화8 pm\n화9 D10\n화13 BM\n화14 PM'),msg('13:05','화8 PM'),msg('15:30','화8라인 액수위 입니다'),msg('16:00','화14 피엠 후 입니다')];
 const {state:s}=reduceEvents(state(),input,now);
 assert.equal(s.chemList[0].status,'완료'); assert.equal(s.chemList[1].lastDone,input[2].postedAt);
 assert.equal(s.chemList[1].status,'완료'); assert.equal(s.chemList[4].lastDone,input[3].postedAt);
 assert.equal(new Date(Date.parse(s.chemList[1].lastDone)+72*3600000).toISOString(),'2026-10-10T06:30:00.000Z');
 assert.deepEqual(reduceEvents(s,input,now).state,s);
 assert.deepEqual(s.unrelated,{preserve:true});
});
test('running time does not move at repeated 3h reports',()=>{
 const s=reduceEvents(state(),[msg('10:05','화8 PM'),msg('13:05','화8 PM')],now).state;
 assert.equal(s.chemList[1].lastDone,'2026-10-07T10:05:00+09:00');
});
test('progress report multiline and production declaration finish correct line',()=>{
 const s=reduceEvents(state(),[msg('15:50','PM 진행사항\n화7\n본조 세척중\n전20 작업중'),msg('16:40','화7 양산진행 하겠습니다')],now).state;
 assert.equal(s.chemList[0].status,'완료');assert.equal(s.chemList[0].lastDone,'2026-10-07T16:40:00+09:00');
});
test('other process, inline aliases, non-PM BM, unrelated finish never change chemistry',()=>{
 for(const text of ['전20 pm후 액수위 입니다','디화13 PM후','디스미어8 PM 완료','화13 BM','화11 피엠 후','화13 스웰러 PM 완료']) {
  assert.deepEqual(reduceEvents(state(),[msg('15:00',text)],now).state.chemList,state().chemList);
 }
});
test('other process completion cannot spill into preceding chemistry segment',()=>{
 const s=state();s.chemList[0].status='시작';
 const r=reduceEvents(s,[msg('15:00','화7 D10\n전20 PM후 액수위 입니다')],now);
 assert.equal(r.state.chemList[0].status,'시작');
 assert.equal(classify('화8 15시 PM 완료')[0].type,'review');
});
test('schedule and completion process chronologically regardless of input order',()=>{
 const r=plan(state(),[msg('16:00','화8 PM후'),msg('14:00','동도금 10월 8일 PM일정\n화8 18시 촉매건욕','schedule'),msg('10:00','화8 PM')],now);
 assert.equal(r.state.chemList[1].status,'완료');
 assert.equal(r.state.chemList[1].plannedDue,undefined);
});
test('future, negative, uncertain and unpaired completion require review',()=>{
 assert.throws(()=>reduceEvents(state(),[msg('23:59','화8 PM')],now));
 for(const text of ['화8 PM 후 액수위 예정','화8 PM 미완료','화8 액수위 확인 요청','화8 PM 완료 후 양산 예정','화8 양산진행 하겠습니다']) {
  const r=reduceEvents(state(),[msg('15:00',text)],now);
  assert.equal(r.result[0].type,'review');assert.equal(r.state.chemList[1].status,'완료');
 }
});
test('chronological sort and watermark prevent older replay resetting finished PM',()=>{
 const s=reduceEvents(state(),[msg('16:00','화8 PM후'),msg('10:00','화8 PM')],now).state;
 const r=reduceEvents(s,[msg('13:00','화8 PM')],now);
 assert.equal(r.state.chemList[1].lastDone,'2026-10-07T16:00:00+09:00');
 assert.equal(r.result[0].type,'stale');
});
test('timestamps must include timezone; invalid batch produces no partial mutations',()=>{
 const before=state(); assert.throws(()=>reduceEvents(before,[msg('10:00','화8 PM'),{postedAt:'yesterday',text:'화8 PM후'}],now));
 assert.deepEqual(before,state());
});
test('schedule uses production parser and retains completion time',()=>{
 const before=state();
 const r=plan(before,[msg('16:10','동도금 10월 8일 PM일정\n화8 18시 촉매건욕','schedule')],now);
 assert.equal(r.state.chemList[1].plannedDue,'2026-10-08T09:00:00.000Z');
 assert.equal(r.state.chemList[1].lastDone,before.chemList[1].lastDone);
});
test('Firebase refuses access instead of fabricating defaults',async()=>{
 await assert.rejects(sync([],{fetcher:async()=>({ok:false,status:401})}),/401/);
 await assert.rejects(sync([],{fetcher:async()=>({ok:true,json:async()=>null})}),/기존 서버/);
});
test('preview never writes; ETag conflict re-reads, preserves concurrent edits and verifies response',async()=>{
 let reads=0,writes=0; const initial=state(); const concurrent=state();concurrent.unrelated.newValue=7;
 const fetcher=async(url,opt)=>{
  if(!opt.method){reads++;return {ok:true,json:async()=>reads===1?initial:concurrent,headers:{get:()=>`etag${reads}`}};}
  writes++;assert.match(opt.headers['if-match'],/^etag/);
  if(writes===1)return {ok:false,status:412};
  const body=JSON.parse(opt.body);assert.equal(body.unrelated.newValue,7);return {ok:true,status:200,json:async()=>body};
 };
 const preview=await sync([msg('10:00','화8 PM')],{fetcher,now});assert.equal(preview.applied,false);assert.equal(writes,0);
 reads=0;
 const applied=await sync([msg('10:00','화8 PM')],{fetcher,now,apply:true});assert.equal(applied.applied,true);assert.equal(writes,2);
});
