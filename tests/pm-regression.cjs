// Run: node --test tests/pm-regression.cjs
// DOM and Firebase are isolated test doubles. No production database is contacted.
process.env.TZ = 'Asia/Seoul';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const code = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const clone = value => JSON.parse(JSON.stringify(value));

function app({stored = {}, now = '2026-10-01T08:00:00+09:00', storageError = false} = {}) {
  let clock = new Date(now).getTime();
  const nodes = new Map(); const logs = []; const alerts = []; const timers = [];
  class Element {
    constructor(id = '') { this.id=id; this.style={}; this.value=''; this.children=[]; this.className=''; this._html='';
      this.classList={add(){},remove(){}}; }
    set innerHTML(value) {
      this._html=value; this.children=[];
      for (const match of value.matchAll(/id="([^"]+)"/g)) nodes.set(match[1],new Element(match[1]));
    }
    get innerHTML(){return this._html;}
    appendChild(child){this.children.push(child);}
    focus(){} blur(){} select(){} setSelectionRange(){} closest(){return null;}
  }
  for (const match of html.matchAll(/id="([^"]+)"/g)) nodes.set(match[1],new Element(match[1]));
  nodes.get('passTimeInput').value='7시패스';
  const storage = new Map(Object.entries(stored));
  const localStorage = {getItem:key=>{if(storageError)throw Error('blocked');return storage.get(key)??null;},
    setItem:(key,value)=>{if(storageError)throw Error('blocked');storage.set(key,value);}};
  const sessionStorage = {getItem:()=>null,setItem(){}};
  class ClockDate extends Date {
    constructor(...args){super(...(args.length?args:[clock]));}
    static now(){return clock;}
  }
  const context = vm.createContext({Date:ClockDate, console:{error:(...args)=>logs.push(args),warn(){}},
    localStorage,sessionStorage,document:{body:new Element('body'),getElementById:id=>nodes.get(id)||null,createElement:()=>new Element(),
      querySelectorAll:()=>[],querySelector:()=>null,execCommand:()=>true},
    window:{isSecureContext:true,scrollY:320,scrollTo(){}},navigator:{clipboard:{writeText:async()=>{}}},
    alert:text=>alerts.push(text),confirm:()=>true,setTimeout:callback=>{timers.push(callback);return timers.length;},clearTimeout(){},setInterval(){}});
  vm.runInContext(code,context);
  const run = text => vm.runInContext(text,context);
  run('window.onload()');
  return {run,context,nodes,storage,logs,alerts,timers,setNow:value=>{clock=new Date(value).getTime();},
    data:expression=>clone(run(expression)),parse:text=>{nodes.get('kakaoRawInput').value=text;run('parseAndApplyKakaoMsg()');}};
}

test('all tabs and both full modal tables render without swallowed runtime errors',()=>{
  const a=app();
  for(const tab of ['tab1','tab2','tab3','tab4']) a.run(`switchTab('${tab}')`);
  a.run("openModal('matrixModal');openModal('pulseModal')");
  assert.equal(a.logs.length,0);
  assert.equal(a.nodes.get('chemListContainer').children.length >= 5,true);
  assert.match(a.nodes.get('elecGaugesContainer').innerHTML,/전14 산탈지\.산세\.박리/);
  assert.match(html,/<strong>디스미어<\/strong>/);
  assert.match(html,/>블랙홀<\/strong>/);
  assert.match(html,/<strong>전기동<\/strong>/);
});

test('master values beat v45 and v18; missing lines and empty notes recover independently',()=>{
  const a=app({stored:{chem_data_master:JSON.stringify([{id:'화7',lastDone:'2026-09-30T11:20',status:'완료',note:''}]),
    chem_data_v45:JSON.stringify([{id:'화7',lastDone:'2026-09-29T10:00',note:'old'},{id:'화8',lastDone:'2026-09-29T09:00',status:'완료',note:'최신'}]),
    chem_data_v18:JSON.stringify([{id:'화8',lastDone:'2026-09-20T09:00',note:'older'}])}});
  const lines=a.data('chemList');
  assert.equal(lines.length,5);assert.equal(lines[0].lastDone,'2026-09-30T11:20');assert.equal(lines[0].note,'');
  assert.equal(lines[1].note,'최신');
  assert.equal(JSON.parse(a.storage.get('chem_data_master')).length,5);
});

test('corrupt JSON and empty arrays do not abort startup or remove fixed lines',()=>{
  const a=app({stored:{chem_data_master:'broken',chem_data_v45:JSON.stringify([{id:'화9',lastDone:'2026-09-30T09:00',status:'완료',note:'촉매 건욕'}]),
    pulse_data_master:'{',manual_notes_master:'{',elec_dummy_flags_master:'{',pulse_process_flags_master:'{'}});
  assert.equal(a.logs.length,0);assert.equal(a.data('chemList').length,5);assert.equal(a.data('pulseList').length,4);
  assert.equal(a.data('chemList.find(line=>line.id==="화9").note'),'촉매 건욕');
  a.run('chemList=ensureChemIntegrity([],chemList)');assert.equal(a.data('chemList[2].note'),'촉매 건욕');
  const blocked=app({storageError:true});assert.equal(blocked.data('chemList').length,5);
});

test('invalid dates recover and legacy running states remain running',()=>{
  const a=app({stored:{chem_data_master:JSON.stringify([{id:'화7',lastDone:'2026-02-30T25:00',status:'대기',note:''}]),
    chem_data_v45:JSON.stringify([{id:'화7',lastDone:'2026-09-30T10:00',status:'완료',note:'old'}])}});
  assert.equal(a.data('chemList[0].lastDone'),'2026-09-30T10:00');assert.equal(a.data('chemList[0].status'),'시작');
});

test('etching includes Sunday, negative offsets, year rollover, and three-day repeats',()=>{
  const a=app();
  assert.equal(a.run("getEtchingLine(new Date('2026-09-25T00:00'))"),'에3.4');
  assert.equal(a.run("getEtchingLine(new Date('2026-09-24T00:00'))"),'에1.2');
  assert.equal(a.run("getEtchingLine(new Date('2026-09-27T00:00'))"),'에1.2');
  for(let offset=-365;offset<365;offset++) {
    assert.equal(a.run(`getEtchingLine(new Date(2026,8,25+${offset}))`),a.run(`getEtchingLine(new Date(2026,8,28+${offset}))`));
  }
});

test('weekly lines match anchors and no weekend fallback creates electric PM',()=>{
  const a=app();
  assert.deepEqual(a.data("getElectroLines('2026-09-18').map(line=>line.number)"),[12,13,21]);
  assert.deepEqual(a.data("getElectroLines('2026-09-25').map(line=>line.number)"),[13,21]);
  assert.deepEqual(a.data("getElectroLines('2026-10-02').map(line=>line.number)"),[12,13,21]);
  assert.deepEqual(a.data("getElectroLines('2026-10-03')"),[]);
  assert.equal(a.run("getDayLines(new Date('2026-09-28T00:00')).includes('고압수세 1')"),true);
  assert.equal(a.run("getDayLines(new Date('2026-10-05T00:00')).includes('고압수세 1')"),false);
  assert.equal(a.run("getDayLines(new Date('2026-09-28T00:00')).includes('디스미어 11')"),true);
});

test('both chemical completion controls restart 72 hours at exact current time',()=>{
  const a=app({now:'2026-10-01T08:17:25+09:00'});
  a.run("setChemStepStatus(0,'완료')");
  assert.equal(a.run('new Date(chemList[0].lastDone).getMinutes()'),17);
  assert.equal(a.run('(getChemDue(chemList[0])-new Date())/3600000'),72);
  a.run("setChemStepStatusById('화7','시작')");
  const initial=a.run('chemList[0].lastDone');a.setNow('2026-10-01T10:00:00+09:00');
  a.run("setChemStepStatusById('화7','시작')");assert.equal(a.run('chemList[0].lastDone'),initial);
  a.run("completeChemPM('화7')");assert.equal(a.run('(getChemDue(chemList[0])-new Date())/3600000'),72);
});

test('chemical 12-hour transfer and 14-hour delay boundaries retain unfinished status',()=>{
  const a=app();a.run("chemList[0]={...chemList[0],status:'시작',lastDone:'2026-09-30T18:00:00+09:00'};safeRenderAll()");
  let box=a.nodes.get('chem_status_화7').innerHTML;assert.match(box,/PM 목표 시간 경과/);assert.doesNotMatch(box,/양산 가능/);
  assert.equal(a.run('chemList[0].status'),'시작');
  a.setNow('2026-10-01T06:00:00+09:00');a.run('updateLiveTimesOnly(new Date())');
  assert.match(a.nodes.get('chem_status_화7').innerHTML,/액이송 시작 시점/);
});

test('chemical imminent warning reaches 7h and 화8 blocks after 48h',()=>{
  const a=app();a.run("chemList[0]={...chemList[0],status:'완료',lastDone:'2026-09-28T15:00:00+09:00'};chemList[1]={...chemList[1],status:'완료',lastDone:'2026-09-29T07:59:00+09:00'};safeRenderAll()");
  assert.match(a.nodes.get('chem_box_0').innerHTML,/7H 이내 임박/);
  assert.match(a.nodes.get('chem_box_1').innerHTML,/빌드업 금지/);
});

test('day-only entry handles December/January, leap days, invalid and fractional days',()=>{
  const a=app();
  assert.equal(a.run("formatDateOnly(resolveDayInput(1,new Date('2026-12-31T00:00')))"),'2027-01-01');
  assert.equal(a.run("formatDateOnly(resolveDayInput(31,new Date('2027-01-01T00:00')))"),'2026-12-31');
  assert.equal(a.run("resolveDayInput(31,new Date('2026-04-20T00:00'))"),null);
  assert.equal(a.run("resolveDayInput(29,new Date('2026-02-20T00:00'))"),null);
  assert.equal(a.run("formatDateOnly(resolveDayInput(29,new Date('2028-02-20T00:00')))"),'2028-02-29');
  assert.equal(a.run('resolveDayInput(1.5,new Date())'),null);
});

test('parser preserves minute precision and work names, and reverses future ongoing times',()=>{
  const a=app();a.parse('화7 13:20 촉매 건욕 PM 진행중\n화8 07시 17분 화학동 건욕 PM 진행중\n화9 14시 촉매cs 진행중\n화13 12시 전체건욕 진행중');
  const lines=a.data('chemList');
  assert.equal(new Date(lines[0].lastDone).getDate(),30);assert.equal(new Date(lines[0].lastDone).getMinutes(),20);
  assert.equal(lines[0].note,'촉매 건욕');assert.equal(lines[1].note,'화학동 건욕');assert.equal(lines[2].note,'촉매cs');assert.equal(lines[3].note,'전체건욕');
  assert.match(a.nodes.get('shareTextOutput').value,/촉매 건욕/);
});

test('parser completed records differ from planned notices and schedules survive reload',()=>{
  const a=app();a.parse('화8 07:17 화학동 건욕 완료');
  assert.equal(a.run('new Date(chemList[1].lastDone).getDate()'),1);
  assert.equal(a.run('new Date(chemList[1].lastDone).getMinutes()'),17);
  const previous=a.run('chemList[1].lastDone');a.parse('화8 18:20 촉매 건욕');
  assert.equal(a.run('chemList[1].lastDone'),previous);assert.equal(a.run('getChemDue(chemList[1]).getHours()'),18);
  const b=app({stored:Object.fromEntries(a.storage)});assert.equal(b.run('getChemDue(chemList[1]).getMinutes()'),20);
});

test('parser isolates multiple lines, preserves shared descriptions, and deduplicates manual notes',()=>{
  const a=app();const notice='디9 스웰러 건욕, 전18 유산동필터 교체\n전15 프리딥 설비작업\n화7, 화8 07:15 전체건욕 완료';
  a.parse(notice);a.parse(notice);
  const notes=a.data('manualNotes');assert.equal(notes.length,4);
  assert.equal(notes.some(note=>note.line==='디스미어 9'&&note.text==='유산동필터 교체'),false);
  assert.equal(a.run('chemList[0].note'),'전체건욕');assert.equal(a.run('chemList[1].note'),'전체건욕');
  assert.equal(a.run('new Date(chemList[0].lastDone).getMinutes()'),15);
});

test('historical notice uses nearest year without exposing a custom date selection',()=>{
  const a=app({now:'2027-01-01T08:00:00+09:00'});a.parse('12월 31일 PM\n화7 13:00 촉매 건욕 완료');
  assert.equal(a.run('selectedDateStr'),'2027-01-01');assert.equal(a.run('currentDateChoice'),'today');
  assert.equal(a.run('new Date(chemList[0].lastDone).getFullYear()'),2026);
  a.run("selectDayFromMatrix('2026-09-25')");assert.equal(a.run('selectedDateStr'),'2027-01-01');
});

test('manual notes on other weekdays and custom lines appear in briefing; tags are line-specific',()=>{
  const a=app();a.run("manualNotes=[{date:selectedDateStr,line:'디스미어 9',text:'스웰러 건욕'},{date:selectedDateStr,line:'커스텀',text:'인써트 교체'}];generateShareText()");
  assert.match(a.nodes.get('shareTextOutput').value,/디스미어 9 스웰러 건욕/);assert.match(a.nodes.get('shareTextOutput').value,/커스텀 인써트 교체/);
  a.run("onManualLineChange('화7')");assert.equal(a.nodes.get('dynamicTagsContainer').children.some(node=>node.innerText==='촉매cs'),true);
  a.nodes.get('dynamicTagsContainer').children=[];a.run("onManualLineChange('전기동 9')");
  assert.equal(a.nodes.get('dynamicTagsContainer').children.some(node=>node.innerText==='+ 유산동필터 교체'),false);
});

test('all four pulse stages advance at 90 minutes without premature completion text',()=>{
  const a=app({now:'2026-09-28T23:00:00+09:00'});a.run("togglePulseProcess('전기동 9라인',true)");
  const stages=['0.5 DC 더미','1.5 DC 더미','펄스대비 패스','펄스 더미'];
  for(let step=0;step<4;step++) {
    a.setNow(new Date(new Date('2026-09-28T23:00:00+09:00').getTime()+step*90*60000).toISOString());a.run('updateLiveTimesOnly(new Date())');
    const detail=a.nodes.get('pulse_status_detail_2026-09-28_전기동 9라인').innerHTML;
    assert.match(detail,new RegExp('\\['+stages[step].replace('.','\\.')+'\\]'));assert.doesNotMatch(detail,/\[펄스 4단계 완료\]/);
  }
  a.setNow('2026-09-29T05:00:00+09:00');a.run('updateLiveTimesOnly(new Date())');
  assert.match(a.nodes.get('pulse_status_detail_2026-09-28_전기동 9라인').innerHTML,/6시간 경과/);
  a.run('tick()');assert.equal(a.run('selectedDateStr'),'2026-09-29');
  assert.match(a.nodes.get('elecGaugesContainer').innerHTML,/2026-09-28 미완료/);
});

test('electric dummy cycle ends at 90min and delay turns on at 20:30, including 전12',()=>{
  const a=app({now:'2026-10-02T19:00:00+09:00'});a.run("toggleElecDummy('전기동 12라인',true)");
  a.setNow('2026-10-02T20:29:00+09:00');a.run('updateLiveTimesOnly(new Date())');
  let detail=a.nodes.get('elec_dummy_est_2026-10-02_전기동 12라인').innerHTML;
  assert.match(detail,/1분 남음/);assert.doesNotMatch(detail,/12시간 초과 지연/);
  a.setNow('2026-10-02T20:30:00+09:00');a.run('updateLiveTimesOnly(new Date())');
  detail=a.nodes.get('elec_dummy_est_2026-10-02_전기동 12라인').innerHTML;
  assert.match(detail,/1.5시간 완료/);assert.match(detail,/12시간 초과 지연/);
});

test('120/240/360-day schedule and reminder remain on D28, D-Day and overdue dates',()=>{
  const a=app({now:'2026-10-01T12:00:00+09:00'});
  a.run("pulseList[0].lastDate='2026-07-01';renderPulseTable()");
  assert.match(a.nodes.get('remindBannerText').innerHTML,/전기동 9라인/);
  assert.equal(a.nodes.get('remindBanner').style.display,'flex');
  a.setNow('2026-10-29T12:00:00+09:00');a.nodes.get('pulseTableBody').children=[];a.run('renderPulseTable()');
  assert.match(a.nodes.get('pulseTableBody').children[0].innerHTML,/D-Day/);
  a.setNow('2026-10-30T12:00:00+09:00');a.run('renderPulseTable()');assert.match(a.nodes.get('remindBannerText').innerHTML,/D\+1/);
  assert.equal(a.run("formatDateOnly(new Date(new Date('2026-07-01T00:00').getTime()+360*86400000))"),'2027-06-26');
});

test('remote records are cached, partial chem data keeps five lines, and empty notes really clear',()=>{
  const a=app();a.run("acceptRemoteState({chemList:[{id:'화7',lastDone:'2026-10-01T07:00',status:'완료',note:'원격'}],manualNotes:[]})");
  assert.equal(JSON.parse(a.storage.get('chem_data_master'))[0].note,'원격');assert.equal(a.data('chemList').length,5);
  a.run("manualNotes=[{date:selectedDateStr,line:'디스미어 9',text:'old'}];lastLocalState=currentState();acceptRemoteState({chemList:chemList})");
  assert.equal(a.data('manualNotes').length,0);
});

test('offline changes survive reload and server refresh without losing unrelated lines',()=>{
  const a=app();a.run("chemList[0].note='오프라인 작업';syncDataToFirebase()");
  assert.equal(JSON.parse(a.storage.get('pm_pending_changes_master')).length>0,true);
  const b=app({stored:Object.fromEntries(a.storage)});
  b.run("acceptRemoteState({chemList:[{id:'화7',lastDone:'2026-10-01T06:00',status:'완료',note:'서버'},{id:'화8',lastDone:'2026-10-01T07:00',status:'완료',note:'다른 브라우저'}]})");
  assert.equal(b.run('chemList[0].note'),'오프라인 작업');assert.equal(b.run('chemList[1].note'),'다른 브라우저');
});

test('Firebase transactions combine independent browser edits and preserve unknown root fields',async()=>{
  const a=app(),b=app();let remote=a.data('currentState()');remote.extra='preserve';
  const attach=instance=>{
    instance.context.testDb={ref:()=>({transaction:async update=>{remote=clone(update(clone(remote)));return {committed:true,snapshot:{val:()=>clone(remote)}};}})};
    instance.run('db=testDb;isFirebaseConnected=true;remoteLoaded=true');
  };
  attach(a);attach(b);
  a.run("chemList[0].note='A';syncDataToFirebase()");b.run("chemList[1].note='B';syncDataToFirebase()");
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(remote.chemList[0].note,'A');assert.equal(remote.chemList[1].note,'B');assert.equal(remote.extra,'preserve');
  assert.equal(a.data('pendingChanges').length,0);assert.equal(b.data('pendingChanges').length,0);
});

test('remote deletion of manual notes merges with concurrent additions',()=>{
  const a=app();a.run("manualNotes=[{date:selectedDateStr,line:'디스미어 9',text:'삭제'}];lastLocalState=currentState();manualNotes=[];syncDataToFirebase();acceptRemoteState({chemList:chemList,manualNotes:[{date:selectedDateStr,line:'디스미어 9',text:'삭제'},{date:selectedDateStr,line:'전기동 18',text:'신규'}]})");
  assert.deepEqual(a.data('manualNotes').map(note=>note.text),['신규']);
});

test('mobile safe areas, 16px forms and touch manipulation remain',()=>{
  assert.match(html,/viewport-fit=cover/);assert.match(html,/safe-area-inset-bottom/);
  assert.match(html,/input, select, textarea\s*\{[^}]*font-size: 16px/);
  assert.match(html,/touch-action: manipulation/);
});

test('partial pulse master fills missing lines from newest legacy sources',()=>{
  const a=app({stored:{pulse_data_master:JSON.stringify([{line:'전기동 9라인 (펄스)',lastDate:'2026-10-01'}]),
    pulse_data_v45:JSON.stringify([{line:'전기동 9라인 (펄스)',lastDate:'2026-09-01'},{line:'전기동 20라인 (펄스)',lastDate:'2026-09-20'}])}});
  assert.equal(a.run('pulseList[0].lastDate'),'2026-10-01');assert.equal(a.run('pulseList[1].lastDate'),'2026-09-20');
  assert.equal(a.data('pulseList').length,4);
});

test('new browser caches its first Firebase snapshot before any user edit',()=>{
  const a=app();const callbacks={};
  const remote=a.data('currentState()');remote.chemList[0].note='중앙 기록';
  a.context.firebase={apps:[{}],database:()=>({ref:path=>({on:(event,callback)=>{callbacks[path]=callback;}})})};
  a.run('initFirebase()');
  callbacks['pm_system_data']({val:()=>remote});callbacks['.info/connected']({val:()=>true});
  assert.equal(JSON.parse(a.storage.get('chem_data_master'))[0].note,'중앙 기록');
  assert.match(a.nodes.get('syncStatus').textContent,/실시간 서버 연결됨/);
  const b=app({stored:Object.fromEntries(a.storage)});assert.equal(b.run('chemList[0].note'),'중앙 기록');
});

test('PM opens without Google sign-in or an authentication SDK',()=>{
  assert.doesNotMatch(html,/firebase-auth-compat|authGate|signInWithPopup|GoogleAuthProvider|id="appContent" hidden/);
  const a=app();
  assert.equal(a.logs.length,0);
  assert.equal(a.data('chemList').length,5);
  assert.match(a.nodes.get('shareTextOutput').value,/동도금/);
});

test('denied server access retains local edits and never reports transport-only connection as synced',async()=>{
  const a=app();const callbacks={};let denied;
  a.context.firebase={apps:[{}],database:()=>({ref:path=>({on:(event,callback,error)=>{
    callbacks[path]=callback;if(path==='pm_system_data') denied=error;
  },transaction:async update=>({committed:true,snapshot:{val:()=>update(a.data('currentState()'))}})})})};
  a.run('initFirebase()');
  denied({code:'PERMISSION_DENIED'});
  callbacks['.info/connected']({val:()=>true});
  assert.match(a.nodes.get('syncStatus').textContent,/서버 접근 제한/);
  assert.equal(a.run('remoteLoaded'),false);
  a.run("chemList[0].note='로컬 작업';syncDataToFirebase()");
  assert.equal(JSON.parse(a.storage.get('chem_data_master'))[0].note,'로컬 작업');
  assert.equal(a.data('pendingChanges').length>0,true);
  callbacks['pm_system_data']({val:()=>a.data('currentState()')});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(a.run('databaseReadError'),false);
  assert.match(a.nodes.get('syncStatus').textContent,/실시간 서버 연결됨/);
});

test('failed Firebase write keeps user changes for retry rather than losing them',async()=>{
  const a=app();a.context.testDb={ref:()=>({transaction:async()=>{throw Error('permission denied');}})};
  a.run("db=testDb;isFirebaseConnected=true;remoteLoaded=true;chemList[0].note='보관';syncDataToFirebase()");
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(a.data('pendingChanges').length>0,true);
  assert.equal(JSON.parse(a.storage.get('chem_data_master'))[0].note,'보관');
  assert.match(a.nodes.get('syncStatus').textContent,/서버 저장 실패/);
});

test('empty-server initialization cannot overwrite a second browser record created during the race',()=>{
  const a=app();
  a.run("const seed=[{field:'chemList',key:'화7',value:{...chemList[0],note:'기본'},ifMissing:true}];const race=applyChanges({chemList:[{...chemList[0],note:'먼저 입력한 기록'}]},seed)");
  assert.equal(a.run('race.chemList[0].note'),'먼저 입력한 기록');
});

test('화8 permits exactly 48 hours and prohibits after that boundary',()=>{
  const a=app();a.run("chemList[1]={...chemList[1],status:'완료',lastDone:'2026-09-29T08:00:00+09:00'};safeRenderAll()");
  assert.match(a.nodes.get('chem_box_1').innerHTML,/빌드업 가능/);
  a.setNow('2026-10-01T08:00:01+09:00');a.run('updateChemRealtimeStatuses()');
  assert.match(a.nodes.get('chem_box_1').innerHTML,/빌드업 금지/);
});

test('legacy chemistry note timestamp is removed while the corrected start time appears once',()=>{
  const a=app({stored:{chem_data_master:JSON.stringify([{id:'화13',lastDone:'2026-09-30T10:00',status:'시작',note:'13시 촉매건욕'}])}});
  assert.equal(a.run("chemList.find(line=>line.id==='화13').note"),'촉매 건욕');
  const line=a.nodes.get('shareTextOutput').value.split('\n').find(text=>text.startsWith('-화13'));
  assert.equal(line,'-화13 10시 촉매 건욕 PM 진행중');
  assert.equal(JSON.parse(a.storage.get('chem_data_master'))[3].note,'촉매 건욕');
  a.parse('화13 11:20 진행중');
  const corrected=a.nodes.get('shareTextOutput').value.split('\n').find(text=>text.startsWith('-화13'));
  assert.equal(corrected,'-화13 11시 20분 촉매 건욕 PM 진행중');
  assert.equal(a.run("cleanChemNote('13:00 13시 촉매건욕 PM진행중')"),'촉매 건욕');
});

test('remote dirty labels and time-only manual corrections cannot reintroduce duplicate clocks',()=>{
  const a=app();a.run("acceptRemoteState({chemList:[{id:'화13',lastDone:'2026-09-30T13:00',status:'시작',note:'13시 촉매건욕'}]});safeRenderAll()");
  a.run("openChemTimeEditor('화13')");
  a.nodes.get('chemEditDay').value='30';a.nodes.get('chemEditHour').value='10';a.nodes.get('chemEditMinute').value='0';
  a.run('saveChemTimeEditor()');
  assert.equal(a.nodes.get('shareTextOutput').value.split('\n').find(text=>text.startsWith('-화13')),'-화13 10시 촉매 건욕 PM 진행중');
  assert.deepEqual(a.data('inlineDesmearFlags'),{});
  const b=app({stored:Object.fromEntries(a.storage)});
  assert.equal(b.nodes.get('shareTextOutput').value.split('\n').find(text=>text.startsWith('-화13')),'-화13 10시 촉매 건욕 PM 진행중');
});

test('single-save time editor saves half-hour minutes, month rollover and start status without counting PM',()=>{
  const a=app({now:'2026-12-31T23:00:00+09:00'});
  a.run("chemList[3]={id:'화13',lastDone:'2026-12-31T13:00:00+09:00',status:'시작',note:'촉매 건욕'};openChemTimeEditor('화13')");
  a.nodes.get('chemEditDay').value='1';a.nodes.get('chemEditHour').value='0';a.nodes.get('chemEditMinute').value='30';
  a.run('saveChemTimeEditor()');
  assert.equal(a.run("formatDateOnly(new Date(chemList[3].lastDone))"),'2027-01-01');
  assert.equal(a.run('new Date(chemList[3].lastDone).getMinutes()'),30);
  assert.equal(a.run('chemList[3].status'),'시작');
  assert.deepEqual(a.data('inlineDesmearFlags'),{});
  assert.equal(a.nodes.get('chemTimeModal').style.display,'none');
});

test('time editor refuses invalid input and concurrent remote edits instead of overwriting',()=>{
  const a=app();a.run("openChemTimeEditor('화13')");
  const previous=a.run('chemList[3].lastDone');
  a.nodes.get('chemEditHour').value='25';a.nodes.get('chemEditMinute').value='30';a.run('saveChemTimeEditor()');
  assert.equal(a.run('chemList[3].lastDone'),previous);
  assert.match(a.nodes.get('chemTimeError').textContent,/선택/);
  a.nodes.get('chemEditHour').value='10';a.nodes.get('chemEditMinute').value='30';
  a.run("chemList[3].note='전체건욕';saveChemTimeEditor()");
  assert.equal(a.run('chemList[3].lastDone'),previous);
  assert.match(a.nodes.get('chemTimeError').textContent,/다른 곳/);
});

test('briefing cards escape manual content and do not diverge from copied report',()=>{
  const a=app();a.parse('화13 13시 촉매건욕 PM 진행중');
  a.run("manualNotes.push({date:selectedDateStr,line:'기타',text:'<img src=x onerror=alert(1)>'});generateShareText()");
  const cards=a.nodes.get('briefingCards').innerHTML;
  assert.match(cards,/화13 13시 촉매 건욕 PM 진행중/);
  assert.match(cards,/&lt;img/);assert.doesNotMatch(cards,/<img/);
  assert.match(a.nodes.get('shareTextOutput').value,/화13 13시 촉매 건욕 PM 진행중/);
  assert.equal(a.nodes.get('kakaoPanel').open,false);
  assert.match(a.nodes.get('uiToast').textContent,/반영 완료/);
});

test('attention summary respects 7-hour and 14-hour boundaries and preferences survive reload',()=>{
  const a=app();
  assert.equal(a.run("chemAttention({status:'시작',lastDone:new Date(Date.now()-14*3600000).toISOString()})"),'late');
  assert.equal(a.run("chemAttention({status:'완료',lastDone:new Date(Date.now()-65*3600000).toISOString()})"),'warn');
  a.nodes.get('passTimeInput').value='7시30분패스';a.run('savePassPreference()');
  const b=app({stored:Object.fromEntries(a.storage)});
  assert.equal(b.nodes.get('passTimeInput').value,'7시30분패스');
  assert.match(b.nodes.get('shareTextOutput').value,/7시30분패스/);
});

test('paste parsing waits for native insertion and applies exactly the new notice',()=>{
  const a=app();a.nodes.get('kakaoRawInput').value='';
  a.run('queueKakaoPaste()');const apply=a.timers.at(-1);
  a.nodes.get('kakaoRawInput').value='화13 07:17 촉매건욕 PM 진행중';apply();
  assert.equal(a.run('new Date(chemList[3].lastDone).getMinutes()'),17);
  assert.equal(a.run('chemList[3].note'),'촉매 건욕');
  assert.equal(a.nodes.get('kakaoRawInput').value,'');
  assert.equal(a.alerts.length,0);
});

test('copy gives nonblocking feedback and invalid notices remain available for correction',async()=>{
  const a=app();await a.run('copyShareText()');
  assert.match(a.nodes.get('uiToast').textContent,/복사 완료/);
  a.parse('아무 일정 없음');
  assert.equal(a.nodes.get('kakaoRawInput').value,'아무 일정 없음');
  assert.match(a.nodes.get('uiToast').textContent,/찾지 못/);
  assert.equal(a.alerts.length,0);
});

test('tomorrow gauge shows future chemistry as planned rather than already due',()=>{
  const a=app();a.run("chemList=chemList.map(line=>({...line,status:'완료',lastDone:'2026-09-29T10:00:00+09:00'}));selectQuickDay('tomorrow');renderActiveChemGauges(new Date())");
  const gauge=a.nodes.get('activeChemGaugesContainer').innerHTML;
  assert.match(gauge,/화7 PM 예정/);assert.match(gauge,/예정 시간 전/);
  assert.doesNotMatch(gauge,/주기 도래|예정 시간 도래/);
});

test('unseeded chemistry completions never generate inline desmear from legacy counters',()=>{
  const legacy={화13:{chemPmCount:2,configured:true},화14:{chemPmCount:1,configured:true}};
  const a=app({stored:{inline_desmear_flags_master:JSON.stringify(legacy)}});
  a.run("setChemStepStatusById('화13','시작');completeChemPM('화13')");
  a.setNow('2026-10-04T08:00:00+09:00');
  a.run("selectQuickDay('today');setChemStepStatusById('화13','시작');completeChemPM('화13');setChemStepStatusById('화14','시작');completeChemPM('화14')");
  assert.deepEqual(a.data('inlineDesmearFlags'),legacy);
  assert.doesNotMatch(a.nodes.get('shareTextOutput').value,/디스미어 13|디스미어 14/);
  assert.doesNotMatch(a.nodes.get('inlineDesmearStatusContainer').innerHTML,/2회|0\/2|1\/2|2\/2|미완료/);
  const b=app({stored:Object.fromEntries(a.storage)});
  assert.deepEqual(b.data('inlineDesmearFlags'),legacy);
  assert.doesNotMatch(b.nodes.get('shareTextOutput').value,/디스미어 13|디스미어 14/);
});

test('one manual anchor enables an inline PM on every second chemistry cycle including next-day cutoff',()=>{
  const a=app({now:'2026-10-01T12:00:00+09:00'});
  a.run("openInlineManualEntry('화14');addManualNote()");
  assert.deepEqual(a.data("getInlineCycle('화14')"),{date:'2026-10-01',count:0});
  // Chemistry on the same day as the manually registered inline PM belongs to the anchor cycle.
  a.run("setChemStepStatusById('화14','시작');completeChemPM('화14')");
  assert.equal(a.run("getInlineCycle('화14').count"),0);
  a.setNow('2026-10-02T07:30:00+09:00');
  a.run("setChemStepStatusById('화14','시작');completeChemPM('화14');selectQuickDay('tomorrow')");
  assert.equal(a.run("getInlineCycle('화14').count"),1);
  a.run("selectedDateStr='2026-10-04';safeRenderAll()");
  const share=a.nodes.get('shareTextOutput').value;
  assert.match(share,/화14 익일\(5일\) 7시 30분/);
  assert.match(share,/디스미어 14 5일 기본PM/);
  assert.equal(share.split('디스미어 14').length-1,1);
  assert.match(a.nodes.get('briefingCards').innerHTML,/디스미어 14 5일 기본PM/);
  assert.match(a.run("inlineControlsHtml('화14')"),/2회마다 1회/);
  const b=app({stored:Object.fromEntries(a.storage),now:'2026-10-04T12:00:00+09:00'});
  assert.equal(b.run("getInlineCycle('화14').count"),1);
  assert.match(b.nodes.get('shareTextOutput').value,/디스미어 14 5일 기본PM/);
  b.setNow('2026-10-05T07:30:00+09:00');
  b.run("setChemStepStatusById('화14','시작');completeChemPM('화14');selectQuickDay('today')");
  assert.equal(b.run("getInlineCycle('화14').count"),2);
  assert.equal(b.run("getInlineDue('화14')"),null);
  b.run("completeChemPM('화14')");assert.equal(b.run("getInlineCycle('화14').count"),2);
  b.setNow('2026-10-08T07:30:00+09:00');
  b.run("setChemStepStatusById('화14','시작');completeChemPM('화14')");
  assert.equal(b.run("getInlineCycle('화14').count"),3);
  assert.equal(b.run("formatDateOnly(getInlineDue('화14'))"),'2026-10-11');
});

test('13 and 14 count separately; time edits and planned notices do not count PM',()=>{
  const a=app({now:'2026-10-02T12:00:00+09:00'});
  a.run("manualNotes=[{date:'2026-10-01',line:'디스미어 13',text:'기본PM'},{date:'2026-10-01',line:'디스미어 14',text:'망간 건욕'}]");
  a.run("setChemStepStatusById('화13','시작');completeChemPM('화13')");
  assert.equal(a.run("getInlineCycle('화13').count"),1);
  assert.equal(a.run("getInlineCycle('화14').count"),0);
  a.parse('화14 5일 07:30 화학동 건욕');
  assert.equal(a.run("getInlineCycle('화14').count"),0);
  a.run("openChemTimeEditor('화13')");
  a.nodes.get('chemEditDay').value='2';a.nodes.get('chemEditHour').value='11';a.nodes.get('chemEditMinute').value='30';
  a.run('saveChemTimeEditor()');
  assert.equal(a.run("getInlineCycle('화13').count"),1);
});

test('briefing uses the requested desmear wording and includes next-morning manual PM',()=>{
  const a=app({now:'2026-10-04T12:00:00+09:00'});
  a.run("manualNotes=[{date:'2026-10-04',line:'디스미어 13',text:'망간 건욕'},{date:'2026-10-05',line:'디스미어 14',text:'기본PM'}];chemList[4].plannedDue='2026-10-05T07:30:00+09:00';safeRenderAll()");
  assert.deepEqual(a.data("inlineBriefingLines('2026-10-04')"),['디스미어 13 망간건욕','디스미어 14 5일 기본PM']);
  assert.match(a.nodes.get('briefingCards').innerHTML,/디스미어 13 망간건욕/);
  assert.match(a.nodes.get('briefingCards').innerHTML,/디스미어 14 5일 기본PM/);
  assert.doesNotMatch(a.nodes.get('shareTextOutput').value,/디화|화학동 분리 요청/);
  a.run("chemList[4].plannedDue='2026-10-05T08:30:00+09:00';safeRenderAll()");
  assert.doesNotMatch(a.nodes.get('shareTextOutput').value,/디스미어 14/);
  a.run("chemList[4].plannedDue='2026-10-05T07:30:00+09:00';manualNotes[1].text='10시 기본PM';safeRenderAll()");
  assert.doesNotMatch(a.nodes.get('shareTextOutput').value,/디스미어 14/);
});

test('inline follow-up honors 08:30 cutoff and matrix calendar date',()=>{
  const a=app({now:'2026-10-04T12:00:00+09:00'});
  a.run("manualNotes=[{date:'2026-10-01',line:'디스미어 14',text:'기본PM'}];inlineDesmearFlags={'completion:test':{version:2,lineId:'화14',completedAt:'2026-10-02T07:30:00+09:00'}};chemList[4].status='완료';chemList[4].plannedDue='2026-10-05T08:30:00+09:00';safeRenderAll()");
  assert.doesNotMatch(a.nodes.get('shareTextOutput').value,/디스미어 14/);
  a.run("chemList[4].plannedDue='2026-10-05T08:00:00+09:00';safeRenderAll()");
  assert.match(a.nodes.get('shareTextOutput').value,/디스미어 14 5일 기본PM/);
  a.run("renderInlineDesmearMatrix([{dateStr:'2026-10-04'},{dateStr:'2026-10-05'}])");
  assert.equal(a.nodes.get('inline_cell_1').innerHTML,'-');
  assert.match(a.nodes.get('inline_cell_2').innerHTML,/디스미어 14.*<br>8시 기본PM/);
});

test('parsed chemistry completion records only an actual started PM once',()=>{
  const a=app({now:'2026-10-02T12:00:00+09:00'});
  a.run("manualNotes=[{date:'2026-10-01',line:'디스미어 13',text:'기본PM'}]");
  a.parse('화13 08:00 PM 시작');a.parse('화13 10:30 PM 완료');
  assert.equal(a.run("getInlineCycle('화13').count"),1);
  a.parse('화13 10:30 PM 완료');
  assert.equal(a.run("getInlineCycle('화13').count"),1);
  assert.equal(a.run("formatDateOnly(getInlineDue('화13'))"),'2026-10-05');
});

test('new manual anchor resets the cycle; deleting the only anchor disables automatic PM',()=>{
  const a=app({now:'2026-10-04T12:00:00+09:00'});
  a.run("manualNotes=[{date:'2026-10-01',line:'디스미어 13',text:'기본PM'}];setChemStepStatusById('화13','시작');completeChemPM('화13')");
  assert.equal(a.run("getInlineCycle('화13').count"),1);
  a.run("openInlineManualEntry('화13');addManualNote()");
  assert.equal(a.run("getInlineCycle('화13').count"),0);
  assert.equal(a.run("getInlineDue('화13')"),null);
  a.run("removeManualNote(1);removeManualNote(0)");
  assert.equal(a.run("getInlineCycle('화13')"),null);
});

test('concurrent completion records merge without losing lines or double-counting one started PM',()=>{
  const a=app({now:'2026-10-02T12:00:00+09:00'});
  a.run("manualNotes=[{date:'2026-10-01',line:'디스미어 13',text:'기본PM'},{date:'2026-10-01',line:'디스미어 14',text:'기본PM'}];setChemStepStatusById('화13','시작');setChemStepStatusById('화14','시작')");
  const remote=a.data('currentState()');
  a.run("completeChemPM('화13')");
  const changes13=a.data("pendingChanges.filter(item=>item.field==='inlineDesmearFlags')");
  const b=app({now:'2026-10-02T12:01:00+09:00'});
  b.context.remote=remote;b.run('acceptRemoteState(remote)');
  b.run("completeChemPM('화13');completeChemPM('화14')");
  b.context.changes13=changes13;
  b.run('pendingChanges=[];acceptRemoteState(applyChanges(currentState(),changes13))');
  assert.equal(b.run("getInlineCycle('화13').count"),1);
  assert.equal(b.run("getInlineCycle('화14').count"),1);
});

test('inline entry shortcut selects line and default PM without saving anything',()=>{
  const a=app();a.run("openInlineManualEntry('화14')");
  assert.equal(a.nodes.get('manualLineSelect').value,'디스미어 14');
  assert.equal(a.nodes.get('manualDayInput').value,1);
  assert.equal(a.nodes.get('manualContentInput').value,'기본PM');
  assert.deepEqual(a.data('manualNotes'),[]);
  assert.match(a.run("inlineControlsHtml('화14')"),/디스미어 PM 입력/);
  assert.doesNotMatch(a.run("inlineControlsHtml('화14')"),/select|횟수/);
});

test('manually registered inline PM appears only on entered date and survives reload',()=>{
  const a=app();a.run("openInlineManualEntry('화13')");
  a.nodes.get('manualDayInput').value='2';a.nodes.get('manualContentInput').value='10시 스웰러 건욕';
  const chemistry=a.data('chemList');a.run('addManualNote()');
  assert.doesNotMatch(a.nodes.get('shareTextOutput').value,/디스미어 13/);
  assert.match(a.nodes.get('inline_cell_5').innerHTML,/디스미어 13.*<br>10시 스웰러 건욕/);
  assert.deepEqual(a.data('chemList'),chemistry);
  a.run("selectQuickDay('tomorrow')");
  assert.match(a.nodes.get('shareTextOutput').value,/디스미어 13 10시 스웰러 건욕/);
  assert.match(a.nodes.get('inlineDesmearStatusContainer').innerHTML,/10시 스웰러 건욕/);
  const b=app({stored:Object.fromEntries(a.storage)});b.run("selectQuickDay('tomorrow')");
  assert.match(b.nodes.get('shareTextOutput').value,/디스미어 13 10시 스웰러 건욕/);
  b.run('removeManualNote(0)');
  assert.doesNotMatch(b.nodes.get('shareTextOutput').value,/디스미어 13/);
  assert.equal(b.nodes.get('inline_cell_5').innerHTML,'-');
  for(let day=1;day<=7;day++) assert.match(html,new RegExp('id="inline_cell_'+day+'"'));
});

test('inline manual tags include basic PM and the existing five desmear tags, and deduplicate',()=>{
  const a=app();a.nodes.get('dynamicTagsContainer').children=[];
  a.run("openInlineManualEntry('화13')");
  assert.deepEqual(a.nodes.get('dynamicTagsContainer').children.map(child=>child.innerText),['기본PM','스웰러 건욕','망간 건욕','인써트 교체','전체건욕','설비작업']);
  a.run('addManualNote()');a.nodes.get('manualContentInput').value='기본PM';a.run('addManualNote()');
  assert.equal(a.data('manualNotes').length,1);
  assert.equal(a.nodes.get('shareTextOutput').value.split('디스미어 13').length-1,1);
  assert.match(a.nodes.get('inline_cell_4').innerHTML,/기본PM/);
});

test('Kakao desmear notices require manual registration while chemistry aliases still update',()=>{
  const a=app();const original=a.data('chemList');
  a.parse('디화13 12:20 디스미어 PM 스웰러 건욕\n디14 13시 망간 건욕');
  assert.deepEqual(a.data('chemList'),original);assert.deepEqual(a.data('manualNotes'),[]);
  assert.deepEqual(a.data('inlineDesmearFlags'),{});
  assert.match(a.nodes.get('uiToast').textContent,/수동/);
  a.parse('디화14 06시 화학동 건욕 진행중');
  assert.equal(a.run('chemList[4].status'),'시작');assert.equal(a.run('chemList[4].note'),'화학동 건욕');
  a.parse('디화14 07시 화학동 건욕 완료');
  assert.deepEqual(a.data('inlineDesmearFlags'),{});
  a.parse('디화13 스웰러 건욕\n디7 망간 건욕');
  assert.equal(a.data('manualNotes').length,1);assert.equal(a.data('manualNotes')[0].line,'디스미어 7');
});

test('legacy inline metadata stays stored while remote manual registrations still merge',()=>{
  const legacy={화13:{chemPmCount:2,status:'시작',startedAt:'2026-10-01T05:00:00+09:00'}};
  const a=app({stored:{inline_desmear_flags_master:JSON.stringify(legacy)}});
  a.run("acceptRemoteState({chemList,inlineDesmearFlags,manualNotes:[{date:selectedDateStr,line:'디스미어 14',text:'망간 건욕'}]});safeRenderAll()");
  assert.deepEqual(JSON.parse(a.storage.get('inline_desmear_flags_master')),legacy);
  assert.doesNotMatch(a.nodes.get('shareTextOutput').value,/디스미어 13/);
  assert.match(a.nodes.get('shareTextOutput').value,/디스미어 14 망간건욕/);
});

test('manual PM minute controls allow only 00/30 and do not round stored precision on opening',()=>{
  const a=app();a.run("chemList[0].lastDone='2026-10-01T07:17:00+09:00';openChemTimeEditor('화7')");
  const previous=a.run('chemList[0].lastDone');
  assert.equal(a.nodes.get('chemEditMinute').value,'');
  assert.match(a.nodes.get('chemEditMinute').innerHTML,/value="0"/);
  assert.match(a.nodes.get('chemEditMinute').innerHTML,/value="30"/);
  assert.doesNotMatch(a.nodes.get('chemEditMinute').innerHTML,/value="17"/);
  a.run('saveChemTimeEditor()');assert.equal(a.run('chemList[0].lastDone'),previous);
  a.nodes.get('chemEditMinute').value='17';a.run('saveChemTimeEditor()');assert.equal(a.run('chemList[0].lastDone'),previous);
  a.nodes.get('chemEditMinute').value='0';a.run('saveChemTimeEditor()');
  assert.equal(a.run('new Date(chemList[0].lastDone).getMinutes()'),0);
});

test('electric manual minute correction rejects non-half-hours and preserves absolute timer dates',()=>{
  const a=app();a.run("togglePulseProcess('전기동 21라인',true);pulseProcessFlags[timerKey('전기동 21라인')].startedAt='2026-10-01T07:17:00+09:00'");
  a.run("updatePulseProcessTime('전기동 21라인','m','17')");
  assert.equal(a.run("new Date(pulseProcessFlags[timerKey('전기동 21라인')].startedAt).getMinutes()"),17);
  a.run("updatePulseProcessTime('전기동 21라인','m','30')");
  assert.equal(a.run("new Date(pulseProcessFlags[timerKey('전기동 21라인')].startedAt).getMinutes()"),30);
  assert.equal(a.run("formatDateOnly(new Date(pulseProcessFlags[timerKey('전기동 21라인')].startedAt))"),'2026-10-01');
});

test('time editor focuses the title without opening a keyboard and restores background scroll',()=>{
  const a=app();const doc=a.context.document;
  const trigger={isConnected:true,focus:options=>{trigger.options=options;},blur(){}};
  doc.activeElement=trigger;
  let titleFocus=null,restoredY=null;
  a.nodes.get('chemTimeTitle').focus=options=>{titleFocus=options;};
  a.nodes.get('chemEditDay').focus=()=>assert.fail('Opening must not focus the numeric input');
  a.context.window.scrollTo=(x,y)=>{restoredY=y;};
  Object.assign(doc.body.style,{position:'',top:'',width:'',overflow:''});
  a.run("openChemTimeEditor('화13')");
  assert.equal(titleFocus.preventScroll,true);
  assert.equal(doc.body.style.position,'fixed');
  assert.equal(doc.body.style.top,'-320px');
  a.context.window.scrollY=0;
  a.run("openModal('chemTimeModal');closeModal('chemTimeModal')");
  assert.equal(restoredY,320);
  assert.equal(doc.body.style.position,'');
  assert.equal(doc.body.style.overflow,'');
  assert.equal(trigger.options.preventScroll,true);
});
