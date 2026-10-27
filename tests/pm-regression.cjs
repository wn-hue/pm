// Run: node --test tests/pm-regression.cjs
// DOM and browser storage are isolated test doubles. No network access is available.
process.env.TZ = 'Asia/Seoul';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const code = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const clone = value => JSON.parse(JSON.stringify(value));

function app({stored = {chem_data_master:JSON.stringify([{id:'화7',lastDone:'2026-09-25T00:00',status:'시작',note:'0시PM'},{id:'화8',lastDone:'2026-09-23T18:30',status:'완료',note:''},{id:'화9',lastDone:'2026-09-24T19:30',status:'완료',note:''},{id:'화13',lastDone:'2026-09-22T13:00',status:'완료',note:'촉매건욕'},{id:'화14',lastDone:'2026-09-24T15:00',status:'완료',note:''}])}, now = '2026-10-01T08:00:00+09:00', storageError = false} = {}) {
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
  for (const match of html.matchAll(/<[^>]+id="([^"]+)"[^>]*>/g)) {
    const node=new Element(match[1]);node.hidden=/\bhidden\b/.test(match[0]);node.open=/\bopen\b/.test(match[0]);nodes.set(match[1],node);
  }
  // Compatibility targets for persisted timer rules; these do not exist in the app UI.
  for(const id of ['elecGaugesContainer','activeChemGaugesContainer','elecTodayLinesBadge','btnRestoreElec','chemListContainer']) nodes.set(id,new Element(id));
  const storage = new Map(Object.entries(stored));
  const localStorage = {getItem:key=>{if(storageError)throw Error('blocked');return storage.get(key)??null;},
    setItem:(key,value)=>{if(storageError)throw Error('blocked');storage.set(key,value);},removeItem:key=>{if(storageError)throw Error('blocked');storage.delete(key);},get length(){return storage.size;},key:i=>[...storage.keys()][i]};
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

test('backlight PM starts only marked lines and production restarts 72 hours at message time',()=>{
  const a=app({now:'2026-10-03T12:00:00+09:00'});
  a.parse('2026년 10월 2일\n[작업자] [오후 10:27] 22시 빽라이트 입니다\n화7 D10\n화8 PM\n화9 D10\n화13 D10\n화14 D10\n이상입니다');
  assert.equal(a.run("chemList[1].status"),'시작');
  assert.equal(a.run("new Date(chemList[1].lastDone).getHours()"),22);
  assert.equal(a.run("new Date(chemList[1].lastDone).getMinutes()"),0);
  const other=a.data('chemList[2]');
  a.parse('2026년 10월 3일\n[작업자] [오전 10:20] 화학동 8라인 양산 진행하겠습니다.');
  assert.equal(a.run("chemList[1].status"),'완료');
  assert.equal(a.run("new Date(getChemDue(chemList[1])).toISOString()"),'2026-10-06T01:20:00.000Z');
  assert.deepEqual(a.data('chemList[2]'),other);
});

test('repeated backlight PM, repeated completion and old replay do not move the cycle',()=>{
  const a=app({now:'2026-10-03T12:00:00+09:00'});
  a.parse('2026년 10월 2일\n22시 백라이트 입니다\n화9 PM\n이상입니다');
  const start=a.run('chemList[2].lastDone');
  a.parse('2026년 10월 3일\n1시 빽라이트 입니다\n화9 PM\n이상입니다');
  assert.equal(a.run('chemList[2].lastDone'),start);
  a.parse('2026년 10월 3일\n[작업자] [오전 10:20] 화학동9 액수위 입니다.');
  const done=a.run('chemList[2].lastDone');
  a.parse('2026년 10월 3일\n[작업자] [오전 11:20] 화9 양산하겠습니다');
  assert.equal(a.run('chemList[2].lastDone'),done);
  a.parse('2026년 10월 2일\n22시 백라이트 입니다\n화9 PM\n이상입니다');
  assert.equal(a.run('chemList[2].status'),'완료');
  assert.equal(a.run('chemList[2].lastDone'),done);
});

test('PM evidence survives reload; an untimed completion clears without changing records',()=>{
  const a=app({now:'2026-10-03T12:00:00+09:00'});
  a.parse('2026년 10월 2일\n22시 빽라이트 입니다\n화13 PM\n이상입니다');
  const b=app({stored:Object.fromEntries(a.storage),now:'2026-10-03T12:00:00+09:00'});
  b.parse('화학동13 액수위입니다');
  assert.equal(b.run('chemList[3].status'),'시작');
  assert.equal(b.nodes.get('kakaoRawInput').value,'');
  b.parse('2026년 10월 3일\n[작업자] [오전 10:20] 화학동13 액수위입니다');
  assert.equal(b.run('chemList[3].status'),'완료');
  assert.equal(b.run('new Date(chemList[3].lastDone).getMinutes()'),20);
});

test('ordinary water reports and negative or planned production do not complete PM',()=>{
  const a=app({now:'2026-10-03T12:00:00+09:00'});
  const before=a.data('chemList[1]');
  a.parse('화8 10:20 액수위입니다');
  assert.deepEqual(a.data('chemList[1]'),before);
  a.parse('2026년 10월 2일\n22시 빽라이트 입니다\n화8 PM\n이상입니다');
  const running=a.data('chemList[1]');
  for(const report of ['아직 양산 진행하겠습니다','양산 진행 못 하겠습니다','양산 시작 예정입니다','액수위 정상 아닙니다','액수위입니다. 양산 대기']) {
    a.parse('화8 10:20 '+report);
    assert.deepEqual(a.data('chemList[1]'),running);
  }
});

test('completion older than PM or dated in the future cannot update the schedule',()=>{
  const a=app({now:'2026-10-03T12:00:00+09:00'});
  a.parse('2026년 10월 2일\n22시 빽라이트 입니다\n화14 PM\n이상입니다');
  const running=a.data('chemList[4]');
  a.parse('2026년 10월 2일\n[작업자] [오후 9:00] 화14 양산하겠습니다');
  assert.deepEqual(a.data('chemList[4]'),running);
  a.parse('2026년 10월 4일\n[작업자] [오전 10:20] 화14 양산하겠습니다');
  assert.deepEqual(a.data('chemList[4]'),running);
});

test('PC export date and AM/PM times distinguish midnight and noon across messages',()=>{
  const a=app({now:'2026-10-03T13:00:00+09:00'});
  a.parse('2026. 10. 2. 오후 10:27, 작업자 : 22시 빽라이트 입니다\n화8 PM\n화9 PM\n이상입니다\n2026. 10. 3. 오전 12:20, 작업자 : 화학동8 액수위입니다\n2026. 10. 3. 오후 12:20, 작업자 : 화학동 9라인 양산 하겠습니다');
  assert.equal(a.run('new Date(chemList[1].lastDone).getHours()'),0);
  assert.equal(a.run('new Date(chemList[2].lastDone).getHours()'),12);
  assert.equal(a.run('chemList[1].status'),'완료');
  assert.equal(a.run('chemList[2].status'),'완료');
});

test('completion needs a copied calendar date and time without a manual time field',()=>{
  const a=app({now:'2026-10-03T12:00:00+09:00'});
  a.parse('2026년 10월 2일\n22시 빽라이트 입니다\n화8 PM\n이상입니다');
  a.parse('[작업자] [오전 10:20] 화8 액수위입니다');
  assert.equal(a.run('chemList[1].status'),'시작');
  a.parse('2026년 10월 3일\n[작업자] [오전 10:20] 화8 액수위입니다');
  assert.equal(a.run('chemList[1].lastDone'),'2026-10-03T01:20:00.000Z');
});

test('exported backlight uses report hour and completion uses posting time, not mentioned PM hour',()=>{
  const a=app({now:'2026-10-03T12:00:00+09:00'});
  a.parse('2026. 10. 2. 오후 10:27, 화7 담당자 : 22시 빽라이트 입니다\n화8 PM\n이상입니다');
  assert.equal(a.run('new Date(chemList[1].lastDone).getMinutes()'),0);
  a.parse('2026년 10월 3일\n[작업자] [오전 10:20] 화8 22시 PM 후 액수위입니다');
  assert.equal(a.run('chemList[1].lastDone'),'2026-10-03T01:20:00.000Z');
});

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
  assert.match(a.nodes.get('shareTextOutput').value,/-화7 13시 PM 진행중/);assert.equal(a.run('chemList[0].note'),'촉매 건욕');
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
  assert.match(a.nodes.get('shareTextOutput').value,/디스미어 9 스웰러 건욕/);assert.match(a.nodes.get('shareTextOutput').value,/커스텀 \(인써트 교체\)/);
  a.run("onManualLineChange('화7')");assert.equal(a.nodes.get('dynamicTagsContainer').children.some(node=>node.innerText==='촉매cs'),false);
  a.nodes.get('dynamicTagsContainer').children=[];a.run("onManualLineChange('전기동 9')");
  assert.equal(a.nodes.get('dynamicTagsContainer').children.some(node=>node.innerText==='유산동 필터 교체'),true);
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
  assert.match(a.run('activePulseReminds.join(" ")'),/전9/);
  assert.equal(a.nodes.get('remindBanner').style.display,'flex');
  a.setNow('2026-10-29T12:00:00+09:00');a.nodes.get('pulseTableBody').children=[];a.run('renderPulseTable()');
  assert.match(a.nodes.get('pulseTableBody').children[0].innerHTML,/D-Day/);
  a.setNow('2026-10-30T12:00:00+09:00');a.run('renderPulseTable()');assert.match(a.run('activePulseReminds.join(" ")'),/D\+1/);
  assert.equal(a.run("formatDateOnly(new Date(new Date('2026-07-01T00:00').getTime()+360*86400000))"),'2027-06-26');
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
  assert.equal(line,'-화13 10시 PM 진행중');
  assert.equal(JSON.parse(a.storage.get('chem_data_master'))[3].note,'촉매 건욕');
  a.parse('화13 11:20 진행중');
  const corrected=a.nodes.get('shareTextOutput').value.split('\n').find(text=>text.startsWith('-화13'));
  assert.equal(corrected,'-화13 11시 PM 진행중');
  assert.equal(a.run("cleanChemNote('13:00 13시 촉매건욕 PM진행중')"),'촉매 건욕');
});

test('restored dirty labels and time-only manual corrections cannot reintroduce duplicate clocks',()=>{
  const a=app();a.run("restoreLocalState({...currentState(),chemList:[{id:'화13',lastDone:'2026-09-30T13:00',status:'시작',note:'13시 촉매건욕'}]});safeRenderAll()");
  a.run("openChemTimeEditor('화13')");
  a.nodes.get('chemEditDay').value='30';a.nodes.get('chemEditHour').value='10';a.nodes.get('chemEditMinute').value='0';
  a.run('saveChemTimeEditor()');
  assert.equal(a.nodes.get('shareTextOutput').value.split('\n').find(text=>text.startsWith('-화13')),'-화13 10시 PM 진행중');
  assert.deepEqual(a.data('inlineDesmearFlags'),{});
  const b=app({stored:Object.fromEntries(a.storage)});
  assert.equal(b.nodes.get('shareTextOutput').value.split('\n').find(text=>text.startsWith('-화13')),'-화13 10시 PM 진행중');
});

test('single-save time editor saves half-hour minutes, month rollover and start status without counting PM',()=>{
  const a=app({now:'2026-12-31T23:00:00+09:00'});
  a.run("chemList[3]={id:'화13',lastDone:'2026-12-31T13:00:00+09:00',status:'시작',note:'촉매 건욕'};openChemTimeEditor('화13')");
  a.nodes.get('chemEditDay').value='1';a.nodes.get('chemEditHour').value='0';a.nodes.get('chemEditMinute').value='30';
  a.setNow('2027-01-01T01:00:00+09:00');a.run('saveChemTimeEditor()');
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

test('notice is rendered as plain text and retains pasted work and manual content',()=>{
  const a=app();a.parse('화13 13시 촉매건욕 PM 진행중');
  a.run("manualNotes.push({date:selectedDateStr,line:'기타',text:'<img src=x onerror=alert(1)>'});generateShareText()");
  assert.match(a.nodes.get('shareTextOutput').value,/<img src=x onerror=alert\(1\)>/);
  assert.equal(a.nodes.get('shareTextOutput').innerHTML,'');
  assert.match(a.nodes.get('noticePreview').innerHTML,/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(a.nodes.get('noticePreview').innerHTML,/<img/);
  assert.match(a.nodes.get('shareTextOutput').value,/화13 13시 PM 진행중/);
  assert.equal(a.nodes.get('kakaoPanel').open,true);
  assert.match(a.nodes.get('kakaoParseResult').textContent,/반영 완료/);
});

test('attention boundaries stay correct and saved custom passes migrate to fixed seven oclock',()=>{
  const a=app();
  assert.equal(a.run("chemAttention({status:'시작',lastDone:new Date(Date.now()-14*3600000).toISOString()})"),'late');
  assert.equal(a.run("chemAttention({status:'완료',lastDone:new Date(Date.now()-65*3600000).toISOString()})"),'warn');
  a.storage.set('pm_ui_preferences_master',JSON.stringify({pass:'7시30분패스'}));a.run('savePassPreference()');
  const b=app({stored:Object.fromEntries(a.storage)});
  assert.equal(JSON.parse(b.storage.get('pm_ui_preferences_master')).pass,'7시패스');
  assert.match(b.nodes.get('shareTextOutput').value,/7시패스/);assert.doesNotMatch(b.nodes.get('shareTextOutput').value,/7시30분패스/);
});

test('paste parsing waits for native insertion and applies exactly the new notice',()=>{
  const a=app();a.nodes.get('kakaoRawInput').value='';
  a.run('queueKakaoPaste()');const apply=a.timers.at(-1);
  a.nodes.get('kakaoRawInput').value='화13 07:17 촉매건욕 PM 진행중';apply();
  assert.equal(a.run('new Date(chemList[3].lastDone).getMinutes()'),17);
  assert.equal(a.run('chemList[3].note'),'촉매 건욕');
  assert.equal(a.nodes.get('kakaoRawInput').value,'');
  assert.equal(a.alerts.length,0);
  assert.equal(a.nodes.get('kakaoPanel').open,true);
  assert.equal(a.nodes.get('noticeDetails').open,true);
  assert.equal(a.nodes.get('kakaoApplyButton').hidden,true);
});

test('briefing month-day label preserves full dates through year rollover and date selection',()=>{
  const a=app({now:'2026-12-31T09:00:00+09:00'});
  assert.equal(a.nodes.get('briefingDateLabel').textContent,'12. 31.');
  a.run("selectQuickDay('tomorrow')");
  assert.equal(a.nodes.get('briefingDateLabel').textContent,'1. 1.');
  assert.equal(a.nodes.get('briefingDateInput').value,'2027-01-01');
  assert.match(a.nodes.get('shareTextOutput').value,/1월 1일 PM일정/);
  a.run("selectBriefingDate('2026-12-31')");assert.equal(a.run('currentDateChoice'),'today');
  a.run("selectBriefingDate('2027-01-01')");assert.equal(a.run('currentDateChoice'),'tomorrow');
  a.run("selectBriefingDate('2027-02-03')");assert.equal(a.run('currentDateChoice'),'custom');
  assert.equal(a.nodes.get('briefingDateLabel').textContent,'2. 3.');
});

test('sheet downward dismissal restores the page while horizontal, short and scrolled gestures keep it open',()=>{
  const a=app();const content={style:{}},body={scrollTop:0};
  for(const id of ['matrixModal','pulseModal']) a.nodes.get(id).querySelector=selector=>selector==='.modal-content'?content:body;
  let prevented=0,restored=null;
  a.context.window.scrollTo=(x,y)=>{restored=y;};
  a.context.headerTarget={closest:selector=>selector.includes('.modal-header')?{}:null};
  a.context.bodyTarget={closest:()=>null};
  a.context.buttonTarget={closest:()=>({})};
  a.context.touch=(target,x,y)=>({target,touches:[{clientX:x,clientY:y}],cancelable:true,preventDefault(){prevented++;}});
  a.run("openModal('matrixModal');startSheetSwipe(touch(headerTarget,100,20),'matrixModal');moveSheetSwipe(touch(headerTarget,102,115),'matrixModal');endSheetSwipe('matrixModal')");
  assert.equal(a.nodes.get('matrixModal').style.display,'none');assert.equal(content.style.transform,'');
  assert.equal(restored,320);assert.equal(prevented,1);
  a.run("openModal('pulseModal');startSheetSwipe(touch(bodyTarget,20,20),'pulseModal');moveSheetSwipe(touch(bodyTarget,130,30),'pulseModal');endSheetSwipe('pulseModal')");
  assert.equal(a.nodes.get('pulseModal').style.display,'flex');assert.equal(prevented,1);
  a.run("startSheetSwipe(touch(headerTarget,20,20),'pulseModal');moveSheetSwipe(touch(headerTarget,20,65),'pulseModal');endSheetSwipe('pulseModal')");
  assert.equal(a.nodes.get('pulseModal').style.display,'flex');assert.equal(content.style.transform,'');
  body.scrollTop=100;
  a.run("startSheetSwipe(touch(bodyTarget,20,20),'pulseModal');moveSheetSwipe(touch(bodyTarget,20,150),'pulseModal');endSheetSwipe('pulseModal')");
  assert.equal(a.nodes.get('pulseModal').style.display,'flex');
  body.scrollTop=0;
  a.run("startSheetSwipe(touch(buttonTarget,20,20),'pulseModal');moveSheetSwipe(touch(buttonTarget,20,150),'pulseModal');endSheetSwipe('pulseModal')");
  assert.equal(a.nodes.get('pulseModal').style.display,'flex');
  a.run("startSheetSwipe(touch(bodyTarget,20,20),'pulseModal');moveSheetSwipe(touch(bodyTarget,20,150),'pulseModal');resetSheetSwipe('pulseModal');endSheetSwipe('pulseModal')");
  assert.equal(a.nodes.get('pulseModal').style.display,'flex');assert.equal(content.style.transform,'');
  a.run("startSheetSwipe(touch(bodyTarget,20,20),'pulseModal');moveSheetSwipe(touch(bodyTarget,20,150),'pulseModal');endSheetSwipe('pulseModal')");
  assert.equal(a.nodes.get('pulseModal').style.display,'none');
});

test('copy gives nonblocking feedback and unrecognized notices clear without a blocking prompt',async()=>{
  const a=app();await a.run('copyShareText()');
  assert.match(a.nodes.get('uiToast').textContent,/복사 완료/);
  a.parse('아무 일정 없음');
  assert.equal(a.nodes.get('kakaoRawInput').value,'');
  assert.match(a.nodes.get('kakaoParseResult').textContent,/찾지 못/);
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
  const b=app({stored:Object.fromEntries(a.storage)});
  assert.deepEqual(b.data('inlineDesmearFlags'),legacy);
  assert.doesNotMatch(b.nodes.get('shareTextOutput').value,/디스미어 13|디스미어 14/);
});

test('one manual anchor enables an inline PM on every second chemistry cycle including next-day cutoff',()=>{
  const a=app({now:'2026-10-01T12:00:00+09:00'});
  a.parse('2026년 10월 1일 PM일정\n디14 기본PM');
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
  assert.match(a.nodes.get('shareTextOutput').value,/디스미어 14 5일 기본PM/);
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
  assert.match(a.nodes.get('shareTextOutput').value,/디스미어 13 망간건욕/);
  assert.match(a.nodes.get('shareTextOutput').value,/디스미어 14 5일 기본PM/);
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
  a.parse('2026년 10월 4일 PM일정\n디13 기본PM');
  assert.equal(a.run("getInlineCycle('화13').count"),0);
  assert.equal(a.run("getInlineDue('화13')"),null);
  a.run("removeManualNote(1);removeManualNote(0)");
  assert.equal(a.run("getInlineCycle('화13')"),null);
});


test('undated inline notices require a date while chemistry aliases still update independently',()=>{
  const a=app();const original=a.data('chemList');
  a.parse('디화13 12:20 디스미어 PM 스웰러 건욕\n디14 13시 망간 건욕');
  assert.deepEqual(a.data('chemList'),original);assert.deepEqual(a.data('manualNotes'),[]);
  assert.deepEqual(a.data('inlineDesmearFlags'),{});
  assert.match(a.nodes.get('kakaoParseResult').textContent,/날짜·시각/);
  a.parse('디화14 06시 화학동 건욕 진행중');
  assert.equal(a.run('chemList[4].status'),'시작');assert.equal(a.run('chemList[4].note'),'화학동 건욕');
  a.parse('디화14 07시 화학동 건욕 완료');
  assert.deepEqual(a.data('inlineDesmearFlags'),{});
  a.parse('디화13 스웰러 건욕\n디7 망간 건욕');
  assert.equal(a.data('manualNotes').length,1);assert.equal(a.data('manualNotes')[0].line,'디스미어 7');
});

test('legacy inline metadata stays stored while local PM registrations are saved',()=>{
  const legacy={화13:{chemPmCount:2,status:'시작',startedAt:'2026-10-01T05:00:00+09:00'}};
  const a=app({stored:{inline_desmear_flags_master:JSON.stringify(legacy)}});
  a.run("restoreLocalState({...currentState(),chemList,inlineDesmearFlags,manualNotes:[{date:selectedDateStr,line:'디스미어 14',text:'망간 건욕'}]});savePMData();safeRenderAll()");
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

test('explicit future or stale PM messages never alter time or work labels',()=>{
  const a=app({now:'2026-10-27T08:00:00+09:00'});
  a.run("chemList[3]={id:'화13',lastDone:'2026-10-26T21:30:00+09:00',status:'시작',note:'촉매 건욕'};chemList=ensureChemIntegrity(chemList)");
  const before=a.data('chemList[3]');
  a.parse('2026년 10월 28일\n화13 13시 화학동 건욕 완료');
  assert.deepEqual(a.data('chemList[3]'),before);
  a.parse('2026년 10월 25일\n화13 13시 전체건욕 완료');
  assert.deepEqual(a.data('chemList[3]'),before);
});

test('unfinished or canceled messages cannot become planned PM and completion uses actual today',()=>{
  const a=app({now:'2026-10-27T08:00:00+09:00'});
  const before=a.data('chemList[1]');
  for(const text of ['화8 07시 PM 미완료','화8 07시 PM 취소','화8 07시 아직 PM 진행']) {
    a.parse(text);assert.deepEqual(a.data('chemList[1]'),before);
  }
  a.run("selectQuickDay('tomorrow')");a.parse('화8 07:17 화학동 건욕 완료');
  assert.equal(a.run('chemList[1].lastDone'),'2026-10-26T22:17:00.000Z');
  assert.equal(a.run('selectedDateStr'),'2026-10-28');
});

test('a new browser shows five unverified lines without invented running PM or overdue counts',()=>{
  const a=app({stored:{},now:'2026-10-27T08:00:00+09:00'});
  assert.equal(a.data('chemList').length,5);
  assert.equal(a.run('chemList.every(line=>line.needsReview)'),true);
  assert.doesNotMatch(a.nodes.get('shareTextOutput').value,/PM 진행중/);
  assert.match(a.nodes.get('tab1ChemStatusContainer').innerHTML,/기록 확인 필요/);
  assert.doesNotMatch(a.nodes.get('tab1ChemStatusContainer').innerHTML,/PM 진행 중|주기 초과/);
  a.run("setChemStepStatusById('화7','시작')");
  assert.equal(a.run('chemList[0].needsReview'),false);
  assert.equal(a.run('chemList[0].lastDone'),'2026-10-26T23:00:00.000Z');
});

test('new-device completion entry initializes the actual cycle instead of legacy dates',()=>{
  const a=app({stored:{},now:'2026-10-27T08:00:00+09:00'});
  a.run("openChemTimeEditor('화13')");
  assert.equal(a.nodes.get('chemEditDay').value,27);
  a.nodes.get('chemEditHour').value='7';a.nodes.get('chemEditMinute').value='30';
  a.run('saveChemTimeEditor()');
  assert.equal(a.run('chemList[3].status'),'완료');
  assert.equal(a.run('chemList[3].needsReview'),false);
  assert.equal(a.run('chemList[3].lastDone'),'2026-10-26T22:30:00.000Z');
});

test('dynamic legacy versions and automation evidence survive restart',()=>{
  const a=app({stored:{chem_data_v99:JSON.stringify([{id:'화8',lastDone:'2026-10-25T10:17',status:'시작',note:'촉매 건욕',backlightPmAt:'2026-10-25T11:00',previousCompletion:'2026-10-22T10:17',kakaoTimeBasis:'최초 PM 관측 시각',kakaoMessageHash:'hash'}])}});
  const b=app({stored:Object.fromEntries(a.storage)});
  assert.equal(b.run('chemList[1].lastDone'),'2026-10-25T10:17');
  assert.equal(b.run('chemList[1].backlightPmAt'),'2026-10-25T11:00');
  assert.equal(b.run('chemList[1].previousCompletion'),'2026-10-22T10:17');
  assert.equal(b.run('chemList[1].kakaoMessageHash'),'hash');
  assert.equal(b.run('chemList[1].needsReview'),false);
});

test('pasted line-specific times cannot change fixed seven oclock passes in briefing or gauges',()=>{
  const a=app({now:'2026-10-27T08:00:00+09:00'});
  a.parse('10월 27일 PM일정\n전18 6시30분패스\n전22 8시패스');
  assert.match(a.nodes.get('shareTextOutput').value,/전18 산세\.박리 \(7시패스\)/);
  assert.match(a.nodes.get('shareTextOutput').value,/전22 산세\.박리 \(7시패스\)/);
  assert.match(a.nodes.get('elecGaugesContainer').innerHTML,/전18 산세\.박리 \(7시패스\)/);
  a.run("selectQuickDay('tomorrow')");
  assert.match(a.nodes.get('shareTextOutput').value,/전15 산세\.박리 \(7시패스\)/);
  assert.equal(JSON.parse(a.storage.get('pm_ui_preferences_master')).pass,'7시패스');
});

test('electric manual PM override replaces default once and retains filter add-on',()=>{
  const a=app({now:'2026-10-27T08:00:00+09:00'});
  a.run("manualNotes=[{date:selectedDateStr,line:'전기동 18',text:'산탈지.산세.프리딥.박리 유산동필터 교체'}];safeRenderAll()");
  const line=a.nodes.get('shareTextOutput').value.split('\n').find(x=>x.startsWith('전18'));
  assert.equal(line,'전18 산탈지.산세.프리딥.박리 (7시패스) 유산동필터 교체');
  assert.match(a.nodes.get('elecGaugesContainer').innerHTML,/전18 산탈지\.산세\.프리딥\.박리/);
});

test('backlight completion participates in the same two-cycle inline desmear schedule',()=>{
  const a=app({now:'2026-10-27T12:00:00+09:00'});
  a.run("manualNotes=[{date:'2026-10-24',line:'디스미어 13',text:'기본PM'}]");
  a.parse('2026년 10월 26일\n22시 백라이트\n화13 PM\n이상입니다');
  a.parse('2026년 10월 27일\n[작업자] [오전 10:00] 화13 양산하겠습니다');
  assert.equal(a.run("getInlineCycle('화13').count"),1);
  const before=a.data('inlineDesmearFlags');
  a.parse('2026년 10월 27일\n[작업자] [오전 10:00] 화13 양산하겠습니다');
  assert.deepEqual(a.data('inlineDesmearFlags'),before);
});


test('unverified master records cannot shadow actual legacy evidence or fabricate an inline completion',()=>{
  const a=app({stored:{chem_data_master:JSON.stringify([{id:'화13',lastDone:'2026-09-22T13:00',status:'시작',needsReview:true}]),chem_data_v45:JSON.stringify([{id:'화13',lastDone:'2026-10-26T21:30',status:'완료'}])}});
  assert.equal(a.run('chemList[3].lastDone'),'2026-10-26T21:30');assert.equal(a.run('chemList[3].needsReview'),false);
  const b=app({stored:{}});b.run("manualNotes=[{date:'2026-09-01',line:'디스미어 13',text:'기본PM'}];completeChemPM('화13')");
  assert.deepEqual(b.data('inlineDesmearFlags'),{});
});

test('scheduled start and completion messages remain plans rather than actual observations',()=>{
  const a=app();const before=a.run('chemList[1].lastDone');
  a.parse('화8 07시 PM 시작 예정');assert.equal(a.run('chemList[1].lastDone'),before);
  a.parse('화8 07시 PM 완료 예정');assert.equal(a.run('chemList[1].lastDone'),before);
  assert.equal(a.run('getChemDue(chemList[1]).getHours()'),7);
});

test('legacy pass notes and custom preference cannot leak into report, copied text, matrix or gauge',async()=>{
  const a=app({now:'2026-10-27T08:00:00+09:00',stored:{
    pm_ui_preferences_master:JSON.stringify({pass:'9시30분패스',otherPreference:true}),
    manual_notes_master:JSON.stringify([
      {date:'2026-10-27',line:'전기동 18',text:'9시30분패스'},
      {date:'2026-10-27',line:'전기동 22',text:'산탈지.산세.박리 (9시 30분 패스) 유산동필터 교체'},
      {date:'2026-10-27',line:'전기동 15',text:'09:30패스'}
    ])
  }});
  let copied='';a.context.navigator.clipboard.writeText=async value=>{copied=value;};
  await a.run('copyShareText()');
  assert.match(copied,/전18 산세\.박리 \(7시패스\)/);
  assert.match(copied,/전22 산탈지\.산세\.박리 \(7시패스\) 유산동필터 교체/);
  assert.doesNotMatch(copied,/9시|09:30/);
  assert.doesNotMatch(a.nodes.get('elecGaugesContainer').innerHTML,/9시|09:30/);
  assert.equal(a.nodes.get('manualNoteList').children.length,0);
  assert.equal(JSON.parse(a.storage.get('pm_ui_preferences_master')).pass,'7시패스');
  assert.equal(JSON.parse(a.storage.get('pm_ui_preferences_master')).otherPreference,true);
  assert.equal(a.data('manualNotes').length,3); // Historical source notes are preserved.
});

test('inline notice input and preview start open and remain available after a successful import',()=>{
  const a=app();
  assert.equal(a.nodes.get('noticeDetails').open,true);assert.equal(a.nodes.get('kakaoPanel').open,true);
  assert.equal(a.nodes.get('kakaoApplyButton').hidden,true);
  a.nodes.get('kakaoRawInput').value='화8 07:17 화학동 건욕 완료';
  a.run('openNoticePanel()');
  assert.equal(a.nodes.get('kakaoPanel').open,true);
  assert.notEqual(a.run('document.body.style.position'),'fixed');
  a.nodes.get('kakaoPanel').open=false;
  assert.equal(a.nodes.get('kakaoRawInput').value,'화8 07:17 화학동 건욕 완료');
  a.run('openNoticePanel();parseAndApplyKakaoMsg()');
  assert.equal(a.nodes.get('kakaoPanel').open,true);
  assert.equal(a.nodes.get('kakaoApplyButton').hidden,true);
  assert.equal(a.run('new Date(chemList[1].lastDone).getMinutes()'),17);
});

test('an incomplete message clears and reports skipped entries without a time supplement',()=>{
  const a=app({now:'2026-10-03T12:00:00+09:00'});
  a.parse('2026년 10월 2일\n22시 백라이트\n화13 PM\n이상입니다');
  a.run('openNoticePanel()');
  a.parse('화13 액수위입니다');
  assert.equal(a.nodes.get('kakaoPanel').open,true);
  assert.equal(a.nodes.get('kakaoRawInput').value,'');
  assert.match(a.nodes.get('kakaoParseResult').textContent,/날짜·시각/);
  assert.match(a.nodes.get('kakaoParseResult').textContent,/제외/);
  assert.equal(a.run('chemList[3].status'),'시작');
});

test('minimal screen keeps paste and copy while duplicate views and progress controls stay removed',()=>{
  assert.doesNotMatch(html,/id="(?:tab2|tabBtn2|elecGaugesContainer|activeChemGaugesContainer|electricWorkPanel|focusSummary|briefingCards|passTimeInput|liveClock)"/);
  assert.match(html,/id="kakaoRawInput"[^>]+onpaste="queueKakaoPaste\(\)"/);
  assert.match(html,/id="copyBriefingButton"[^>]+onclick="copyShareText\(\)"/);
  const a=app();
  for(const id of ['elecGaugesContainer','activeChemGaugesContainer','elecTodayLinesBadge','btnRestoreElec','chemListContainer']) a.nodes.delete(id);
  a.run("safeRenderAll();tick();switchTab('tab2')");
  assert.equal(a.logs.length,0);
  assert.equal((a.nodes.get('tab1ChemStatusContainer').innerHTML.match(/<article class="chem-overview/g)||[]).length,5);
});

test('top schedule buttons belong only to PM management and return when switching back',()=>{
  const a=app();assert.equal(a.nodes.get('homeScheduleTools').hidden,false);
  a.run("switchTab('tab4')");assert.equal(a.nodes.get('homeScheduleTools').hidden,true);
  a.run("switchTab('tab1')");assert.equal(a.nodes.get('homeScheduleTools').hidden,false);
  assert.equal(a.nodes.get('copySource').hidden,true);
  assert.match(a.nodes.get('noticePreview').innerHTML,/notice-group/);
});

test('compact notice copies the unchanged full Kakao source including blank lines and annotations',async()=>{
  const a=app({now:'2026-10-28T09:00:00+09:00'});
  a.run("manualNotes=[{date:'2026-10-28',line:'디스미어 12',text:'옥사멧 점검',kind:'schedule'}];generateShareText()");
  let copied='';a.context.navigator.clipboard.writeText=async value=>{copied=value;};
  await a.run('copyShareText()');
  assert.equal(copied,a.nodes.get('shareTextOutput').value);
  assert.match(copied,/동도금 10월 28일 PM일정\n\n데3\n\n/);
  assert.match(copied,/디12 기본PM \(옥사멧 점검\)/);assert.match(copied,/7시패스/);
  assert.match(copied,/이상입니다\.$/);
  assert.equal(a.nodes.get('copySource').hidden,true);assert.equal(a.nodes.get('noticePreview').hidden,false);
});

test('copy fallback reveals a selectable source only when necessary and restores the compact view on success',async()=>{
  const a=app();a.context.window.isSecureContext=false;
  let selected=false;a.context.document.execCommand=()=>{selected=!a.nodes.get('copySource').hidden;return true;};
  await a.run('copyShareText()');assert.equal(selected,true);
  assert.equal(a.nodes.get('copySource').hidden,true);assert.equal(a.nodes.get('noticePreview').hidden,false);
  a.context.navigator.clipboard.writeText=async()=>{throw Error('clipboard denied');};a.context.window.isSecureContext=true;
  await a.run('copyShareText()');
  assert.equal(a.nodes.get('copySource').hidden,false);assert.equal(a.nodes.get('noticePreview').hidden,true);
  assert.match(a.nodes.get('uiToast').textContent,/길게 눌러 복사/);
  a.run('generateShareText()');assert.equal(a.nodes.get('copySource').hidden,false);
  a.run('showCopySource(false)');assert.equal(a.nodes.get('noticePreview').hidden,false);
});

test('Korean schedule sentence is previewed then saved, reloaded and copied only on its date',async()=>{
  const a=app({now:'2026-10-27T08:00:00+09:00'});
  const before=a.data('chemList');
  a.nodes.get('scheduleRawInput').value='디스미어12\n옥사멧점검 이번주 수요일에 진행예정 이오니 준비 바랍니다.';
  a.run('parseScheduleInput()');
  assert.equal(a.nodes.get('manualDateInput').value,'2026-10-28');
  assert.equal(a.nodes.get('manualLineSelect').value,'디스미어 12');
  assert.equal(a.nodes.get('manualContentInput').value,'옥사멧 점검');
  assert.deepEqual(a.data('manualNotes'),[]);
  a.run('addManualNote()');
  assert.deepEqual(a.data('manualNotes'),[{date:'2026-10-28',line:'디스미어 12',text:'옥사멧 점검',kind:'schedule'}]);
  assert.doesNotMatch(a.nodes.get('shareTextOutput').value,/옥사멧/);
  const b=app({stored:Object.fromEntries(a.storage),now:'2026-10-28T08:00:00+09:00'});
  const report=b.nodes.get('shareTextOutput').value;
  assert.match(report,/디12 기본PM \(옥사멧 점검\)/);
  assert.equal(report.match(/옥사멧 점검/g).length,1);
  let copied;b.context.navigator.clipboard.writeText=async text=>{copied=text;};
  await b.run('copyShareText()');assert.equal(copied,report);
  assert.deepEqual(a.data('chemList'),before);
  b.run("selectQuickDay('tomorrow')");assert.doesNotMatch(b.nodes.get('shareTextOutput').value,/옥사멧/);
});

test('schedule parsing resolves full dates, relative dates and next week across year boundaries',()=>{
  const a=app({now:'2026-12-31T08:00:00+09:00'});
  for(const [text,date] of [
    ['디12 옥사멧점검 2027년 1월 6일 진행예정','2027-01-06'],
    ['전기동18 1월 1일 설비 점검 예정입니다','2027-01-01'],
    ['화학동7 내일 촉매 점검 예정입니다','2027-01-01'],
    ['디12 다음주 수요일 옥사멧 점검 예정','2027-01-06'],
    ['디12 모레 설비 점검 예정','2027-01-02'],
    ['디12 2027-02-03 옥사멧 점검 예정','2027-02-03']]) {
    const result=a.data(`parseScheduleSentence(${JSON.stringify(text)})`);
    assert.equal(result.date,date,JSON.stringify(result));
  }
  const r=a.data("parseScheduleSentence('이번주 수요일에 디12 옥사멧 점검 진행예정',new Date('2026-10-27T08:00:00+09:00'))");
  assert.equal(r.text,'옥사멧 점검');assert.equal(r.date,'2026-10-28');
});

test('missing, invalid, multiple and recurring schedule dates stay unsaved with an explanation',()=>{
  const a=app({now:'2026-10-27T08:00:00+09:00'});
  for(const text of ['디12 옥사멧 점검','디12 2026-02-30 옥사멧 점검','디12 10월 28일 10월 29일 점검',
    '디12 디11 이번주 수요일 점검','디12 매주 수요일 옥사멧 점검','디12 28일~30일 점검','디12 내일']) {
    a.nodes.get('scheduleRawInput').value=text;a.run('parseScheduleInput()');
    assert.match(a.nodes.get('scheduleParseResult').textContent,/입력|날짜|일정|특이사항/);
    assert.ok(a.run(`Boolean(parseScheduleSentence(${JSON.stringify(text)}).error)`),text);
    assert.equal(a.nodes.get('scheduleRawInput').value,text);
    assert.deepEqual(a.data('manualNotes'),[]);
  }
});

test('saved schedules support arbitrary dates, irregular lines, editing, deduplication and deletion',()=>{
  const a=app({now:'2026-10-27T08:00:00+09:00'});
  a.nodes.get('scheduleRawInput').value='디스미어12 11월 3일 설비 점검 예정';a.run('parseScheduleInput();addManualNote()');
  assert.equal(a.run('manualNotes.length'),1);
  a.run('viewManualNoteDate(0)');assert.equal(a.run('selectedDateStr'),'2026-11-03');
  assert.match(a.nodes.get('shareTextOutput').value,/디12 \(설비 점검\)/);
  a.nodes.get('manualContentInput').value='설비 점검';a.run('addManualNote()');
  assert.equal(a.run('manualNotes.length'),1);assert.match(a.nodes.get('manualSaveResult').textContent,/이미/);
  a.run('editManualNote(0)');a.nodes.get('manualDateInput').value='2026-11-04';
  a.nodes.get('manualContentInput').value='옥사멧 점검';a.run('addManualNote()');
  assert.equal(a.run('manualNotes.length'),1);assert.doesNotMatch(a.nodes.get('shareTextOutput').value,/옥사멧|설비 점검/);
  a.run('viewManualNoteDate(0)');assert.match(a.nodes.get('shareTextOutput').value,/디12 기본PM \(옥사멧 점검\)/);
  const reloaded=app({stored:Object.fromEntries(a.storage)});reloaded.run('viewManualNoteDate(0);removeManualNote(0)');
  assert.equal(reloaded.run('manualNotes.length'),0);assert.doesNotMatch(reloaded.nodes.get('shareTextOutput').value,/옥사멧/);
});

test('scheduled annotations preserve electric work and 7AM pass and do not reset inline cycles',()=>{
  const a=app({now:'2026-10-27T08:00:00+09:00'});
  a.run("manualNotes=[{date:'2026-09-01',line:'디스미어 13',text:'기본PM'}]");
  const cycle=a.data("getInlineCycle('화13')");
  a.nodes.get('scheduleRawInput').value='디스미어13 10월 28일 설비 점검 예정';a.run('parseScheduleInput();addManualNote()');
  assert.deepEqual(a.data("getInlineCycle('화13')"),cycle);
  a.nodes.get('scheduleRawInput').value='전기동18 10월 27일 옥사멧 점검 예정';a.run("parseScheduleInput();addManualNote();selectBriefingDate('2026-10-27')");
  assert.match(a.nodes.get('shareTextOutput').value,/전18 산세\.박리 \(7시패스\) \(옥사멧 점검\)/);
  assert.doesNotMatch(a.nodes.get('shareTextOutput').value,/9시30분패스/);
});


test('changing a schedule date retains its selected line and AM wording is not an electric line',()=>{
  const a=app({now:'2026-10-27T08:00:00+09:00'});
  a.nodes.get('scheduleRawInput').value='디스미어12 10월 28일 오전 10시 옥사멧 점검 예정';
  a.run('parseScheduleInput()');assert.equal(a.nodes.get('manualLineSelect').value,'디스미어 12');
  assert.equal(a.nodes.get('manualContentInput').value,'오전 10시 옥사멧 점검');
  a.nodes.get('manualDateInput').value='2026-10-30';a.run('updateManualLineOptions();addManualNote()');
  assert.equal(a.run('manualNotes[0].line'),'디스미어 12');assert.equal(a.run('manualNotes[0].date'),'2026-10-30');
});

test('PM home restores direct chemistry controls with timing details while special-note correction remains available',()=>{
  assert.doesNotMatch(html,/id="(?:tab3|tabBtn3|chemListContainer)"/);
  const a=app({now:'2026-10-01T08:00:00+09:00'});
  for(const id of ['chemListContainer','elecGaugesContainer','activeChemGaugesContainer','elecTodayLinesBadge','btnRestoreElec']) a.nodes.delete(id);
  let scrolled=false;a.nodes.get('chemManagement').scrollIntoView=()=>{scrolled=true;};
  a.run("switchTab('tab3');safeRenderAll();tick()");
  assert.equal(scrolled,true);assert.equal(a.logs.length,0);
  const home=a.nodes.get('tab1ChemStatusContainer').innerHTML;
  assert.match(home,/화7 PM 완료/);assert.match(home,/화8 PM 시작/);assert.match(home,/화7 시간정정/);
  assert.match(home,/setChemStepStatusById\('화7','완료'\)/);assert.match(home,/openChemTimeEditor\('화8'\)/);
  a.nodes.get('manualChemLine').value='화8';a.run("manualChemAction('time')");
  assert.match(a.nodes.get('chemTimeTitle').textContent,/화8/);
  assert.match(home,/12시간 액이송/);assert.match(home,/14시간 PM 목표/);assert.match(home,/직전 완료/);
});

test('compact chemistry shows the next actionable milestone at the 12 and 14 hour boundaries without auto-completing',()=>{
  const a=app({now:'2026-10-28T09:00:00+09:00'});
  const start={id:'화7',status:'시작',lastDone:'2026-10-28T02:00:00+09:00'};
  a.context.compactLine=start;
  assert.equal(a.run('chemCompactInfo(compactLine).caption'),'액이송');
  assert.equal(a.run('chemCompactTime(chemCompactInfo(compactLine).at)'),'오늘 14:00');
  a.setNow('2026-10-28T14:00:00+09:00');
  assert.equal(a.run('chemCompactInfo(compactLine).caption'),'PM 목표');
  assert.equal(a.run('chemCompactTime(chemCompactInfo(compactLine).at)'),'오늘 16:00');
  assert.equal(a.run('chemCompactInfo(compactLine).state'),'running');
  a.setNow('2026-10-28T16:00:00+09:00');
  assert.equal(a.run('chemCompactInfo(compactLine).state'),'late');assert.equal(start.status,'시작');
  a.context.compactLine={...start,status:'완료',lastDone:'2026-10-26T04:30:00+09:00'};
  assert.equal(a.run('chemCompactInfo(compactLine).caption'),'다음 PM');
  assert.equal(a.run('chemCompactTime(chemCompactInfo(compactLine).at)'),'내일 04:30');
  assert.equal(a.run("chemCompactTime(new Date('2027-01-01T05:30:00+09:00'),new Date('2026-12-31T23:59:00+09:00'))"),'내일 05:30');
});

test('compact chemistry keeps expanded details during refresh and exposes buildup warnings without opening',()=>{
  const a=app({now:'2026-10-28T09:00:00+09:00'});
  a.run("chemList[0]={id:'화7',status:'시작',lastDone:'2026-10-28T02:00:00+09:00',note:'전체건욕 · 기본PM'};chemList[1]={id:'화8',status:'완료',lastDone:'2026-10-26T08:30:00+09:00',note:'촉매 건욕'};renderTab1ChemStatus()");
  const container=a.nodes.get('tab1ChemStatusContainer'),node=a.nodes.get('chemDetail-화7');
  assert.doesNotMatch(container.innerHTML,/role="progressbar"/);
  const summary=container.innerHTML.match(/<summary[^>]*aria-label="화7 상세정보"[^>]*>([\s\S]*?)<\/summary>/)[1];
  assert.match(summary,/전체건욕/);assert.doesNotMatch(summary,/기본PM|경과 시간|PM 시작 시각/);
  assert.match(container.innerHTML,/<summary[^>]*aria-label="화8 상세정보"[^>]*>[\s\S]*?빌드업 금지<\/p><\/summary>/);
  a.run("rememberChemDetail('화7',true);renderTab1ChemStatus()");
  assert.equal(a.nodes.get('chemDetail-화7'),node);
  a.setNow('2026-10-28T09:01:00+09:00');a.run('renderTab1ChemStatus()');
  assert.match(container.innerHTML,/id="chemDetail-화7" class="chem-compact-details" open/);
  assert.match(container.innerHTML,/12시간 액이송/);assert.match(container.innerHTML,/14시간 PM 목표/);
  a.run("rememberChemDetail('화7',false)");a.setNow('2026-10-28T09:02:00+09:00');a.run('renderTab1ChemStatus()');
  assert.doesNotMatch(container.innerHTML,/id="chemDetail-화7" class="chem-compact-details" open/);
  a.run("chemList[0].lastDone='2026-10-28T02:00:30+09:00'");
  a.setNow('2026-10-28T14:00:29+09:00');a.run('renderTab1ChemStatus()');
  const firstSummary=()=>container.innerHTML.match(/<summary[^>]*aria-label="화7 상세정보"[^>]*>([\s\S]*?)<\/summary>/)[1];
  assert.match(firstSummary(),/<span>액이송<\/span>/);
  a.setNow('2026-10-28T14:00:30+09:00');a.run('renderTab1ChemStatus()');
  assert.match(firstSummary(),/<span>PM 목표<\/span>/);
});

test('pulse reminder starts one calendar month ahead including month-end clamping',()=>{
  const a=app({now:'2026-09-28T10:00:00+09:00'});
  a.run("pulseList=pulseList.map(p=>({...p,lastDate:'2026-07-01'}));renderPulseTable()"); // Due October 29.
  assert.equal(a.nodes.get('remindBanner').style.display,'none');
  a.setNow('2026-09-29T00:00:00+09:00');a.run('renderPulseTable()');
  assert.equal(a.nodes.get('remindBanner').style.display,'flex');assert.match(a.nodes.get('remindBannerText').innerHTML,/D-30/);
  assert.equal(a.run("formatDateOnly(pulseReminderStart(new Date('2027-03-31T00:00:00')))"),'2027-02-28');
  assert.equal(a.run("formatDateOnly(pulseReminderStart(new Date('2028-03-31T00:00:00')))"),'2028-02-29');
});

test('top reminder dismissal lasts for the day and refreshes for changed plans or a new day',()=>{
  const a=app({now:'2026-10-28T09:00:00+09:00'}),dismissed=new Map();
  a.context.sessionStorage.getItem=key=>dismissed.get(key)||null;
  a.context.sessionStorage.setItem=(key,value)=>dismissed.set(key,value);
  a.run('renderPulseTable();dismissRemindBanner();renderPulseTable()');assert.equal(a.nodes.get('remindBanner').style.display,'none');
  a.run("selectQuickDay('tomorrow');renderPulseTable()");assert.equal(a.nodes.get('remindBanner').style.display,'none');
  a.run("manualNotes.push({date:'2026-10-31',line:'전기동 20',text:'액퍼내기 확정',kind:'pulse-plan'});renderPulseTable()");
  assert.equal(a.nodes.get('remindBanner').style.display,'flex');
  a.run('dismissRemindBanner()');a.setNow('2026-10-29T09:00:00+09:00');a.run('renderPulseTable()');assert.equal(a.nodes.get('remindBanner').style.display,'flex');
});

test('quick note templates open editable drafts and never save until the user confirms',()=>{
  const a=app({now:'2026-10-28T09:00:00+09:00'}),before=a.data('currentState()');
  for(const [type,text] of [['inspection','설비 점검'],['replacement','인써트 교체'],['pulse','액퍼내기 확정'],['weekday','PM 목요일로 변경']]) {
    a.run(`startNoteTemplate('${type}')`);
    assert.equal(a.nodes.get('manualNoteEditor').hidden,false);assert.equal(a.nodes.get('manualContentInput').value,text);
    assert.deepEqual(a.data('currentState()'),before);
  }
  a.run("startNoteTemplate('pulse')");assert.equal(a.nodes.get('manualLineSelect').value,'전기동 20');
  assert.equal(a.nodes.get('manualDateInput').value,'2026-10-30');a.run('addManualNote()');
  assert.equal(a.run('manualNotes[0].kind'),'pulse-plan');assert.equal(a.run('manualNotes[0].date'),'2026-10-30');
});

test('empty special-notes screen hides editor, parse action and empty saved list',()=>{
  const a=app({stored:{}});
  assert.equal(a.nodes.get('manualNoteEditor').hidden,true);
  assert.equal(a.nodes.get('scheduleParseActions').hidden,true);
  assert.equal(a.nodes.get('manualNoteList').hidden,true);
  assert.equal(a.nodes.get('manualNoteList').innerHTML,'');
  a.nodes.get('scheduleRawInput').value='디12 내일 점검';a.run('updateScheduleInput()');
  assert.equal(a.nodes.get('scheduleParseActions').hidden,false);
  assert.equal(a.nodes.get('manualNoteEditor').hidden,true);
  a.run('parseScheduleInput()');assert.equal(a.nodes.get('manualNoteEditor').hidden,false);
  a.nodes.get('scheduleRawInput').value='디12 모레 다른 점검';a.run('updateScheduleInput()');
  assert.equal(a.nodes.get('manualNoteEditor').hidden,true); // Re-parse changed source before saving.
  a.run('parseScheduleInput();addManualNote()');
  assert.equal(a.nodes.get('manualNoteEditor').hidden,true);assert.equal(a.nodes.get('scheduleParseActions').hidden,true);
  assert.equal(a.nodes.get('manualNoteList').hidden,false);
  a.run('editManualNote(0)');assert.equal(a.nodes.get('manualNoteEditor').hidden,false);
  a.run('cancelManualEdit()');assert.equal(a.nodes.get('manualNoteEditor').hidden,true);
  a.run('openManualNoteEditor()');assert.equal(a.nodes.get('manualNoteEditor').hidden,false);
});

test('past notes are collapsed, current and upcoming work remains visible, and data is retained',()=>{
  const a=app({now:'2026-10-27T08:00:00+09:00'});
  a.run("manualNotes=[{date:'2026-10-01',line:'디스미어 13',text:'인써트 교체'},{date:'2026-10-28',line:'디스미어 12',text:'옥사멧 점검',kind:'schedule'}];renderManualNotesList()");
  const cards=a.nodes.get('manualNoteList').children;
  assert.equal(cards.length,2);assert.equal(cards[0].className,'saved-note');
  assert.match(cards[0].innerHTML,/2026-10-28/);
  assert.equal(cards[1].className,'saved-history');assert.match(cards[1].innerHTML,/<summary>지난 기록 1건<\/summary>/);
  assert.equal(a.run('manualNotes.length'),2);
  a.run("selectBriefingDate('2026-10-01')");
  assert.equal(a.nodes.get('manualNoteList').children.every(n=>n.className==='saved-note'),true);
});

test('remembered-date copy produces its full PM notice with annotations and fixed pass in one action',async()=>{
  const a=app({now:'2026-10-27T08:00:00+09:00'});
  a.run("manualNotes=[{date:'2026-10-28',line:'디스미어 12',text:'옥사멧 점검',kind:'schedule'}]");
  let copied='';a.context.navigator.clipboard.writeText=async value=>{copied=value;};
  await a.run('copyManualNoteDate(0)');
  assert.match(copied,/동도금 10월 28일 PM일정/);assert.match(copied,/디12 기본PM \(옥사멧 점검\)/);
  assert.match(copied,/7시패스/);assert.match(copied,/이상입니다\./);
  assert.equal(copied,a.nodes.get('shareTextOutput').value);
});

test('special-work editor has no PM mode or chemical tags on any line',()=>{
  assert.doesNotMatch(html,/id="manualNoteMode"/);
  const a=app();
  for(const line of ['디스미어 12','디스미어 13','화7','전기동 9','전기동 18','CUSTOM']) {
    a.run(`onManualLineChange(${JSON.stringify(line)})`);
    const tags=a.nodes.get('dynamicTagsContainer').children.map(n=>n.innerText);
    assert.deepEqual(tags,['유산동 필터 교체','옥사멧 점검','인써트 교체','설비공사','설비점검']);
    assert.doesNotMatch(tags.join(' '),/건욕|기본PM|산탈지|산세|박리|촉매cs/);
  }
});

test('both sentence and direct special-work entry reject chemical PM and mixed work without changing records',()=>{
  const a=app({now:'2026-10-27T08:00:00+09:00'}),before=a.data('chemList');
  a.run('openManualNoteEditor()');a.nodes.get('manualLineSelect').value='화7';
  for(const text of ['기본PM','정기 PM','촉매 건욕','화학동 건욕','스웰러 건욕','망간 건욕','전체건욕','약품 교체','산탈지.산세.박리','촉매cs','산세.박리 + 유산동 필터 교체','PM 진행','피 엠','안녕하세요']) {
    a.nodes.get('manualContentInput').value=text;a.run('addManualNote()');
    assert.match(a.nodes.get('manualSaveResult').textContent,/별도|공사/);
    assert.deepEqual(a.data('manualNotes'),[],text);
    const result=a.data(`parseScheduleSentence(${JSON.stringify('화7 내일 '+text)})`);
    assert.ok(result.error,text);
  }
  assert.deepEqual(a.data('chemList'),before);
});

test('external tasks normalize and persist as annotations while chemical equipment repairs remain valid',()=>{
  const a=app({now:'2026-10-27T08:00:00+09:00'}),before=a.data('chemList');
  for(const [input,expected] of [['유산동필터교체','유산동 필터 교체'],['옥사멧점검','옥사멧 점검'],['인서트교체','인써트 교체'],['약품 배관 공사','약품 배관 공사'],['건욕 탱크 보수','건욕 탱크 보수'],['산세 펌프 교체','산세 펌프 교체']]) {
    a.nodes.get('scheduleRawInput').value='디12 10월 28일 '+input+' 예정';a.run('parseScheduleInput();addManualNote()');
    assert.equal(a.data('manualNotes').at(-1).text,expected);
    assert.equal(a.data('manualNotes').at(-1).kind,'schedule');
  }
  a.run("selectBriefingDate('2026-10-28')");
  assert.match(a.nodes.get('shareTextOutput').value,/디12 기본PM \(유산동 필터 교체 · 옥사멧 점검 · 인써트 교체/);
  const b=app({stored:Object.fromEntries(a.storage),now:'2026-10-28T08:00:00+09:00'});
  assert.equal(b.run('manualNotes.length'),6);assert.equal(b.nodes.get('manualNoteList').children.length,6);
  assert.deepEqual(a.data('chemList'),before);
});

test('legacy PM records stay stored and usable but never appear as special-work history or reset via tasks',()=>{
  const notes=[{date:'2026-10-01',line:'디스미어 13',text:'기본PM'},{date:'2026-10-27',line:'디스미어 13',text:'인써트 교체'},
    {date:'2026-10-27',line:'디스미어 9',text:'스웰러 건욕'},{date:'2026-10-27',line:'전기동 18',text:'유산동필터 교체'}];
  const a=app({stored:{manual_notes_master:JSON.stringify(notes)},now:'2026-10-27T08:00:00+09:00'});
  assert.deepEqual(a.data('manualNotes'),notes);
  assert.equal(a.nodes.get('manualNoteList').children.length,2);
  const visible=a.nodes.get('manualNoteList').children.map(n=>n.innerHTML).join(' ');
  assert.doesNotMatch(visible,/기본PM|스웰러 건욕/);
  assert.equal(a.run("getInlineCycle('화13').date"),'2026-10-01');
  assert.match(a.nodes.get('shareTextOutput').value,/전18 산세\.박리 \(7시패스\) \(유산동필터 교체\)/);
});

test('Kakao imports separate external tasks from chemical PM including chemistry and inline lines',()=>{
  const a=app({now:'2026-10-27T08:00:00+09:00'}),before=a.data('chemList');
  a.parse('2026년 10월 28일\n화8 10시 옥사멧 점검\n디13 인써트 교체\n전18 산탈지.산세.박리 유산동필터 교체');
  assert.deepEqual(a.data('chemList'),before);
  assert.equal(a.data('manualNotes').filter(n=>n.kind==='schedule').length,3);
  assert.equal(a.run("getInlineCycle('화13')"),null);
  assert.equal(a.nodes.get('manualNoteList').children.length,3);
  assert.equal(a.data('manualNotes').some(n=>n.kind!=='schedule'&&n.text==='산탈지.산세.박리'),true);
  assert.match(a.nodes.get('shareTextOutput').value,/화8 \(옥사멧 점검\)/);
});

test('non-PM-day special work does not invent a basic PM, chemical work or electric pass',()=>{
  const a=app({now:'2026-10-27T08:00:00+09:00'});
  a.run("manualNotes=[{date:'2026-11-01',line:'디스미어 12',text:'옥사멧 점검',kind:'schedule'},{date:'2026-11-01',line:'전기동 18',text:'유산동 필터 교체',kind:'schedule'}];selectBriefingDate('2026-11-01')");
  const text=a.nodes.get('shareTextOutput').value;
  assert.match(text,/디12 \(옥사멧 점검\)/);assert.match(text,/전18 \(유산동 필터 교체\)/);
  assert.doesNotMatch(text,/디12 기본PM|전18 산세|전18.*패스/);
});

test('custom construction notices do not become chemical PM and mixed notices keep chemical labels clean',()=>{
  const a=app({now:'2026-10-27T18:00:00+09:00'}),before=a.data('chemList');
  a.parse('2026년 10월 28일\n화8 10시 건욕 탱크 보수 예정\n화7 11시 약품 배관 공사 예정');
  assert.deepEqual(a.data('chemList'),before);
  assert.equal(a.run("manualNotes.some(n=>n.kind==='schedule'&&n.text==='건욕 탱크 보수')"),true);
  assert.equal(a.run("manualNotes.some(n=>n.kind==='schedule'&&n.text==='약품 배관 공사')"),true);
  a.parse('2026년 10월 27일\n화8 10시 촉매 건욕 인써트 교체 완료');
  assert.equal(a.run('chemList[1].note'),'촉매 건욕');
  assert.equal(a.run("manualNotes.some(n=>n.kind==='schedule'&&n.text==='인써트 교체')"),true);
});

test('personal app keeps explicit file transfer local without server SDK, login, connection or upload',()=>{
  assert.doesNotMatch(html,/firebase|connectPMServer|syncDataToFirebase|importKakaoEvents|serverLogin|connection-tools|연결 · 데이터 관리|자동 연동 관리|동기화 저장|\bfetch\s*\(|WebSocket|XMLHttpRequest/i);
  assert.match(html,/Content-Security-Policy" content="connect-src 'none'"/);
  const a=app();let calls=0;
  a.context.firebase={initializeApp:()=>{calls++;throw Error('unexpected connection');}};
  a.context.fetch=()=>{calls++;throw Error('unexpected request');};
  a.run('window.onload();savePMData();tick()');
  assert.equal(calls,0);assert.equal(a.logs.length,0);
  assert.equal(a.nodes.get('localSaveStatus').textContent,'');
  assert.equal(a.nodes.get('localSaveStatus').hidden,true);
});

test('local-only edits and deleted notes persist across reloads without a server queue',()=>{
  const a=app({now:'2026-10-27T08:00:00+09:00'});
  a.run("setChemStepStatusById('화13','시작')");
  a.nodes.get('scheduleRawInput').value='디12 내일 옥사멧 점검';a.run('parseScheduleInput();addManualNote()');
  const saved=a.data('currentState()');
  assert.deepEqual(JSON.parse(a.storage.get('pm_local_state_master')),saved);
  assert.equal(a.storage.has('pm_pending_changes_master'),false);
  const b=app({stored:Object.fromEntries(a.storage),now:'2026-10-28T08:00:00+09:00'});
  assert.deepEqual(b.data('currentState()'),saved);
  assert.match(b.nodes.get('shareTextOutput').value,/디12 기본PM \(옥사멧 점검\)/);
  b.run('removeManualNote(0)');
  const c=app({stored:Object.fromEntries(b.storage)});assert.deepEqual(c.data('manualNotes'),[]);
});

test('old unsent notes, chemistry and flags recover locally exactly once, including deletions',()=>{
  const old={date:'2026-10-28',line:'디스미어 12',text:'설비 점검',kind:'schedule'};
  const added={date:'2026-10-28',line:'전기동 18',text:'인써트 교체',kind:'schedule'};
  const changes=[{field:'manualNotes',key:JSON.stringify([old.date,old.line,old.text]),deleted:true},
    {field:'manualNotes',key:JSON.stringify([added.date,added.line,added.text]),value:added},
    {field:'chemList',key:'화7',value:{id:'화7',status:'완료',lastDone:'2026-10-27T07:17:00+09:00',note:'촉매 건욕'}},
    {field:'inlineDesmearFlags',key:'legacy-evidence',value:{version:2,lineId:'화13',completedAt:'2026-10-26T10:00:00+09:00'}}];
  const a=app({stored:{manual_notes_master:JSON.stringify([old]),pm_pending_changes_master:JSON.stringify(changes)},now:'2026-10-27T08:00:00+09:00'});
  assert.deepEqual(a.data('manualNotes'),[added]);assert.equal(a.run('chemList[0].lastDone'),'2026-10-27T07:17:00+09:00');
  assert.ok(a.data('inlineDesmearFlags')['legacy-evidence']);assert.equal(a.storage.has('pm_pending_changes_master'),false);
  const b=app({stored:Object.fromEntries(a.storage),now:'2026-10-27T08:00:00+09:00'});
  assert.deepEqual(b.data('currentState()'),a.data('currentState()'));
});

test('authoritative local snapshot beats stale legacy mirrors and an obsolete retry queue',()=>{
  const a=app();a.run("chemList[0].note='내 최신 기록';savePMData()");
  const stored=Object.fromEntries(a.storage);
  stored.chem_data_master=JSON.stringify([{id:'화7',lastDone:'2026-09-01T00:00',status:'완료',note:'오래된 사본'}]);
  stored.pm_pending_changes_master=JSON.stringify([{field:'chemList',key:'화7',value:{id:'화7',lastDone:'2026-09-01T00:00',status:'완료',note:'이전 대기열'}}]);
  const b=app({stored});assert.equal(b.run('chemList[0].note'),'내 최신 기록');
  assert.equal(b.storage.has('pm_pending_changes_master'),false);
  for(const invalid of ['"broken"','null','{}','[]']) {
    const c=app({stored:{pm_local_state_master:invalid,chem_data_master:a.storage.get('chem_data_master')}});
    assert.equal(c.run('chemList[0].note'),'내 최신 기록');assert.equal(c.logs.length,0);
  }
});

test('single snapshot survives a legacy mirror failure and storage errors remain visible without data loss',()=>{
  const a=app();const original=a.context.localStorage.setItem;
  a.context.localStorage.setItem=(key,value)=>{if(key==='chem_data_master')throw Error('mirror full');original(key,value);};
  a.run("chemList[0].note='새 기록';savePMData()");
  const b=app({stored:Object.fromEntries(a.storage)});assert.equal(b.run('chemList[0].note'),'새 기록');
  const blocked=app({storageError:true});blocked.run("chemList[0].note='메모리 보관';savePMData()");
  assert.equal(blocked.run('chemList[0].note'),'메모리 보관');
  assert.match(blocked.nodes.get('localSaveStatus').textContent,/저장하지 못/);
});

test('saved local state contains PM data only, without pasted raw conversations or authentication data',()=>{
  const a=app();a.nodes.get('kakaoRawInput').value='private conversation';a.run('savePMData()');
  const saved=a.storage.get('pm_local_state_master');
  assert.equal(JSON.parse(saved).chemList.length,5);
  assert.doesNotMatch(saved,/private conversation|apiKey|authToken|pendingChanges/);
});

test('partially damaged local snapshots preserve valid fields and recover broken fields from master keys',()=>{
  const a=app({now:'2026-10-27T08:00:00+09:00'});
  a.run("manualNotes=[{date:'2026-10-28',line:'디스미어 12',text:'옥사멧 점검',kind:'schedule'}];pulseProcessFlags={'2026-10-26_전기동 9라인':{isStarted:true,startedAt:'2026-10-26T22:17:00+09:00'}};savePMData()");
  const stored=Object.fromEntries(a.storage),snapshot=JSON.parse(stored.pm_local_state_master);
  snapshot.chemList[0].note='가장 최근 기록';snapshot.manualNotes=[{broken:true}];snapshot.pulseProcessFlags='damaged';snapshot.elecCompletedFlags={'broken':{invalid:true}};delete snapshot.inlineDesmearFlags;
  stored.pm_local_state_master=JSON.stringify(snapshot);
  const b=app({stored,now:'2026-10-27T08:00:00+09:00'});
  assert.equal(b.run('chemList[0].note'),'가장 최근 기록');assert.equal(b.run('manualNotes[0].text'),'옥사멧 점검');
  assert.equal(b.run("pulseProcessFlags['2026-10-26_전기동 9라인'].startedAt"),'2026-10-26T22:17:00+09:00');
  assert.equal(b.run('chemList.length'),5);assert.equal(b.logs.length,0);assert.deepEqual(b.data('elecCompletedFlags'),a.data('elecCompletedFlags'));
});

test('broken nonempty note and flag masters fall back through all version keys while empty data stays empty',()=>{
  const note={date:'2026-10-28',line:'디스미어 12',text:'옥사멧 점검',kind:'schedule'};
  const a=app({stored:{manual_notes_master:JSON.stringify([{broken:true}]),manual_notes_v73:JSON.stringify([note]),
    pulse_process_flags_master:JSON.stringify({bad:'damaged'}),pulse_process_flags_v12:JSON.stringify({'2026-10-26_전기동 9라인':{isStarted:true,startedAt:'2026-10-26T22:00:00+09:00'}})}});
  assert.deepEqual(a.data('manualNotes'),[note]);assert.ok(a.run("pulseProcessFlags['2026-10-26_전기동 9라인']"));
  const stored=Object.fromEntries(a.storage),snapshot=JSON.parse(stored.pm_local_state_master);snapshot.manualNotes=[];snapshot.pulseProcessFlags={};stored.pm_local_state_master=JSON.stringify(snapshot);
  const b=app({stored});assert.deepEqual(b.data('manualNotes'),[]);assert.deepEqual(b.data('pulseProcessFlags'),{});
});

test('unverified snapshot rows cannot shadow verified cached chemistry while keeping all five cards',()=>{
  const a=app({now:'2026-10-27T08:00:00+09:00'}),stored=Object.fromEntries(a.storage);
  const snapshot=JSON.parse(stored.pm_local_state_master);snapshot.chemList=snapshot.chemList.map(line=>({...line,needsReview:true,lastDone:'2026-09-01T00:00',status:'시작',note:''}));
  stored.pm_local_state_master=JSON.stringify(snapshot);const b=app({stored,now:'2026-10-27T08:00:00+09:00'});
  assert.deepEqual(b.data('chemList').map(n=>[n.id,n.lastDone,n.status,n.note,n.needsReview]),a.data('chemList').map(n=>[n.id,n.lastDone,n.status,n.note,n.needsReview]));
  assert.equal(b.run('chemList.length'),5);
});

test('day-only chemistry corrections preview the full year and month and refuse future actual timestamps',()=>{
  const a=app({now:'2026-12-31T23:00:00+09:00'});
  a.run("chemList[3]={...chemList[3],lastDone:'2026-12-31T13:00:00+09:00',status:'시작'};openChemTimeEditor('화13')");
  const before=a.data('chemList[3]');
  a.nodes.get('chemEditDay').value='1';a.nodes.get('chemEditHour').value='0';a.nodes.get('chemEditMinute').value='30';
  a.run('updateChemTimePreview();saveChemTimeEditor()');
  assert.match(a.nodes.get('chemTimePreview').textContent,/2027년 1월 1일 0시 30분/);
  assert.match(a.nodes.get('chemTimeError').textContent,/미래/);assert.deepEqual(a.data('chemList[3]'),before);
  a.setNow('2027-01-01T01:00:00+09:00');a.run('saveChemTimeEditor()');
  assert.equal(a.run("formatDateOnly(new Date(chemList[3].lastDone))"),'2027-01-01');
});

test('dated Kakao inline PM is the authoritative baseline, replaces a wrong date and survives reload',()=>{
  const a=app({now:'2026-10-28T09:00:00+09:00'}),chemistry=a.data('chemList');
  a.run("manualNotes=[{date:'2026-11-15',line:'디스미어 13',text:'기본PM'},{date:'2026-10-29',line:'디스미어 13',text:'스웰러 건욕'},{date:'2026-10-28',line:'디스미어 12',text:'옥사멧 점검',kind:'schedule'}]");
  a.parse('동도금 10월 28일 PM일정\n디13 30일 망간 건욕\n디14 기본PM');
  assert.equal(a.run("getInlineCycle('화13').date"),'2026-10-30');
  assert.equal(a.run("getInlineCycle('화14').date"),'2026-10-28');
  assert.deepEqual(a.data('chemList'),chemistry);
  a.parse('동도금 10월 28일 PM일정\n디13 29일 스웰러 건욕');
  assert.equal(a.run("getInlineCycle('화13').date"),'2026-10-29');
  assert.equal(a.run("manualNotes.filter(n=>n.line==='디스미어 13'&&n.source==='kakao').length"),1);
  a.run("selectBriefingDate('2026-10-30')");assert.doesNotMatch(a.nodes.get('shareTextOutput').value,/디스미어 13/);
  a.run("selectBriefingDate('2026-10-29')");assert.match(a.nodes.get('shareTextOutput').value,/디스미어 13 스웰러 건욕/);
  a.parse('동도금 10월 28일 PM일정\n디13 29일 스웰러 건욕');
  assert.equal(a.run("manualNotes.filter(n=>n.line==='디스미어 13'&&n.source==='kakao').length"),1);
  const b=app({stored:Object.fromEntries(a.storage),now:'2026-10-29T09:00:00+09:00'});
  assert.equal(b.run("getInlineCycle('화13').date"),'2026-10-29');
  assert.match(b.nodes.get('shareTextOutput').value,/디스미어 13 스웰러 건욕/);
  assert.equal(b.run("manualNotes.some(n=>n.text==='옥사멧 점검')"),true);
});

test('inline notice preserves work time and shares in the 08:30 window without creating chemical completion',()=>{
  const a=app({now:'2026-12-31T09:00:00+09:00'}),before=a.data('chemList');
  a.parse('2026년 12월 31일 PM일정\n디14 익일 1일 07:30 망간 건욕');
  assert.equal(a.run("getInlineCycle('화14').date"),'2027-01-01');
  assert.match(a.nodes.get('shareTextOutput').value,/디스미어 14 1일 7시 30분 망간건욕/);
  assert.deepEqual(a.data('chemList'),before);
  assert.deepEqual(a.data('inlineDesmearFlags'),{});
});

test('electric 12 moves to alternating Thursdays from October 28 consistently in notice and matrix',()=>{
  const a=app({now:'2026-10-28T09:00:00+09:00'});
  for(const [date,expected] of [['2026-10-16',true],['2026-10-29',true],['2026-10-30',false],['2026-11-05',false],['2026-11-12',true]]) {
    assert.equal(a.run(`getElectroLines('${date}').some(n=>n.number===12)`),expected,date);
  }
  a.run("selectBriefingDate('2026-10-29')");
  assert.match(a.nodes.get('shareTextOutput').value,/전12 산탈지\.산세\.박리 \(7시패스\)/);
  assert.match(a.nodes.get('electro_cell_4').innerHTML,/전기동 12/);
  assert.doesNotMatch(a.nodes.get('electro_cell_5').innerHTML,/전기동 12/);
});

test('special-note PM rule previews, persists, edits and deletes with date-scoped recurrence and fixed pass',()=>{
  const a=app({now:'2026-10-28T09:00:00+09:00'});
  a.nodes.get('scheduleRawInput').value='전12 11월 2일부터 PM 매주 화요일로 변경';a.run('parseScheduleInput()');
  assert.equal(a.nodes.get('manualDateInput').value,'2026-11-02');assert.deepEqual(a.data('manualNotes'),[]);
  a.run('addManualNote()');assert.equal(a.run('manualNotes[0].kind'),'pm-rule');
  const b=app({stored:Object.fromEntries(a.storage),now:'2026-10-28T09:00:00+09:00'});
  assert.equal(b.run("getElectroLines('2026-10-29').some(n=>n.number===12)"),true);
  assert.equal(b.run("getElectroLines('2026-11-03').some(n=>n.number===12)"),true);
  assert.equal(b.run("getElectroLines('2026-11-05').some(n=>n.number===12)"),false);
  b.run("selectBriefingDate('2026-11-03')");assert.match(b.nodes.get('shareTextOutput').value,/전12.*7시패스/);
  assert.doesNotMatch(b.nodes.get('shareTextOutput').value,/로 변경/);
  b.run('editManualNote(0)');b.nodes.get('manualContentInput').value='PM 매주 수요일로 변경';b.run('addManualNote()');
  assert.equal(b.run("getElectroLines('2026-11-04').some(n=>n.number===12)"),true);
  assert.equal(b.run("getElectroLines('2026-11-03').some(n=>n.number===12)"),false);
  b.run('removeManualNote(0)');assert.equal(b.run("getElectroLines('2026-11-03').some(n=>n.number===12)"),false);
  assert.equal(b.run("getElectroLines('2026-11-12').some(n=>n.number===12)"),true);
  assert.equal(a.data("parseScheduleSentence('전12 PM 금요일에서 목요일로 변경')").weekday,4);
});

test('confirmed October 30 pulse is a plan in notice and matrix without fabricating a completed bath',()=>{
  const a=app({now:'2026-10-28T09:00:00+09:00'}),before=a.data('pulseList');
  assert.equal(a.run("formatDateOnly(getPulseSchedule(pulseList[1]).due)"),'2026-10-30');
  assert.equal(a.run('getPulseSchedule(pulseList[1]).lastDate'),'2026-06-29');
  a.run("selectBriefingDate('2026-10-30')");
  assert.match(a.nodes.get('shareTextOutput').value,/전20 \(액퍼내기 확정\)/);
  assert.match(a.nodes.get('electro_cell_5').innerHTML,/전기동 20 액퍼내기 확정/);
  const table=a.nodes.get('pulseTableBody').children[1].innerHTML;
  assert.match(table,/10월 30일/);assert.match(table,/확정/);assert.doesNotMatch(table,/<input/);
  assert.deepEqual(a.data('pulseList'),before);
});

test('special-note pulse plan reschedules, reloads and completes only on actual day before restarting 120 days',()=>{
  const a=app({now:'2026-10-28T09:00:00+09:00'}),before=a.data('chemList');
  a.nodes.get('scheduleRawInput').value='전20 10월 30일 액퍼내기 확정';a.run('parseScheduleInput();addManualNote()');
  assert.equal(a.run('manualNotes[0].kind'),'pulse-plan');
  assert.equal(a.nodes.get('manualCustomLineInput').style.display,'none');
  a.run('editManualNote(0)');a.nodes.get('manualDateInput').value='2026-10-31';a.run('addManualNote()');
  assert.equal(a.run("formatDateOnly(getPulseSchedule(pulseList[1]).due)"),'2026-10-31');
  a.run("selectBriefingDate('2026-10-30')");assert.doesNotMatch(a.nodes.get('shareTextOutput').value,/전20/);
  const b=app({stored:Object.fromEntries(a.storage),now:'2026-10-28T09:00:00+09:00'});
  assert.equal(b.run("formatDateOnly(getPulseSchedule(pulseList[1]).due)"),'2026-10-31');
  b.nodes.get('scheduleRawInput').value='전20 10월 31일 액퍼내기 완료';b.run('parseScheduleInput()');
  assert.match(b.nodes.get('scheduleParseResult').textContent,/미래/);assert.equal(b.run('manualNotes.length'),1);
  b.setNow('2026-10-31T15:00:00+09:00');b.run('parseScheduleInput();addManualNote()');
  assert.equal(b.run('getPulseSchedule(pulseList[1]).lastDate'),'2026-10-31');
  assert.equal(b.run('getPulseSchedule(pulseList[1]).planned'),undefined);
  assert.equal(b.run("(getPulseSchedule(pulseList[1]).due-new Date('2026-10-31T00:00:00'))/86400000"),120);
  assert.deepEqual(b.data('chemList'),before);
});

test('completed pulse accepts a recent past date without rolling it into next year',()=>{
  const a=app({now:'2026-10-31T09:00:00+09:00'});
  const parsed=a.data("parseScheduleSentence('전20 10월 30일 액퍼내기 완료')");
  assert.equal(parsed.date,'2026-10-30');assert.equal(parsed.kind,'pulse-complete');
  const rollover=a.data("parseScheduleSentence('전20 12월 31일 액퍼내기 완료',new Date('2027-01-01T09:00:00+09:00'))");
  assert.equal(rollover.date,'2026-12-31');
});

test('rule and pulse drafts reject ambiguity and unsupported lines without changing stored schedules',()=>{
  const a=app({now:'2026-10-28T09:00:00+09:00'}),before=a.data('currentState()');
  for(const raw of ['전12 PM 매주 격주 목요일로 변경','전12 10월 30일부터 11월 2일까지 PM 목요일로 변경','디12 PM 목요일로 변경','전18 10월 30일 액퍼내기 확정','전20 10월 30일 액퍼내기 미완료']) {
    assert.ok(a.data(`parseScheduleSentence(${JSON.stringify(raw)})`).error,raw);
  }
  assert.deepEqual(a.data('currentState()'),before);
  a.nodes.get('scheduleRawInput').value='전12 PM 목요일로 변경';a.run('parseScheduleInput()');
  assert.equal(a.nodes.get('dynamicTagsContainer').hidden,true);a.run('addManualNote()');
  a.nodes.get('scheduleRawInput').value='전12 PM 매주 수요일로 변경';a.run('parseScheduleInput();addManualNote()');
  assert.equal(a.run("manualNotes.filter(n=>n.kind==='pm-rule').length"),1);
});

test('mobile dock switches its primary action and copy date follows year boundaries',()=>{
  const a=app({now:'2026-12-31T09:00:00+09:00'});
  assert.equal(a.nodes.get('pmCopyAction').hidden,false);
  assert.equal(a.nodes.get('noteCreateButton').hidden,true);
  a.run("selectQuickDay('tomorrow')");
  assert.equal(a.nodes.get('copyBriefingDate').textContent,'1. 1.');
  assert.match(a.nodes.get('briefingDateContext').textContent,/금요일 · 내일/);
  assert.equal(a.run('selectedDateStr'),'2027-01-01');
  a.run("switchTab('tab4')");
  assert.equal(a.nodes.get('pmCopyAction').hidden,true);
  assert.equal(a.nodes.get('noteCreateButton').hidden,false);
  assert.equal(a.nodes.get('pmHeader').hidden,true);
  a.run("switchTab('tab1')");
  assert.equal(a.nodes.get('pmCopyAction').hidden,false);
  assert.equal(a.nodes.get('copyBriefingDate').textContent,'1. 1.');
});

test('mobile page navigation restores each scroll position and active-tab tap goes to the top',()=>{
  const a=app();
  a.context.window.scrollTo=(options,y)=>{a.context.window.scrollY=typeof options==='object'?options.top:y;};
  a.context.window.scrollY=760;
  a.run("switchTab('tab4')");assert.equal(a.context.window.scrollY,0);
  a.context.window.scrollY=120;
  a.run("switchTab('tab1')");assert.equal(a.context.window.scrollY,760);
  a.run("switchTab('tab4')");assert.equal(a.context.window.scrollY,120);
  a.run("switchTab('tab4')");assert.equal(a.context.window.scrollY,0);
  a.run("switchTab('tab1',{top:true})");assert.equal(a.context.window.scrollY,0);
});

test('note sheet preserves a dismissed draft and saves only after date-line review',()=>{
  const a=app({now:'2026-10-28T09:00:00+09:00'}),before=a.data('currentState()');
  a.run('openNoteComposer()');assert.equal(a.run('activeModalId'),'noteComposerModal');
  a.nodes.get('scheduleRawInput').value='디12 10월 28일 옥사멧 점검';
  a.run("closeModal('noteComposerModal');openNoteComposer()");
  assert.equal(a.nodes.get('scheduleRawInput').value,'디12 10월 28일 옥사멧 점검');
  assert.deepEqual(a.data('currentState()'),before);
  a.run('parseScheduleInput()');assert.equal(a.nodes.get('noteDraftEntry').hidden,true);
  assert.equal(a.nodes.get('manualNoteEditor').hidden,false);
  assert.equal(a.run('activeModalId'),'noteComposerModal');
  assert.deepEqual(a.data('currentState()'),before);
  a.run('addManualNote()');assert.equal(a.run('activeModalId'),null);
  assert.equal(a.nodes.get('manualEmptyState').hidden,true);
  assert.match(a.run('generateShareText();document.getElementById("shareTextOutput").value'),/디12 기본PM \(옥사멧 점검\)/);
  const reloaded=app({stored:Object.fromEntries(a.storage),now:'2026-10-28T09:00:00+09:00'});
  assert.equal(reloaded.run('manualNotes[0].text'),'옥사멧 점검');
});

test('invalid note stays in the sheet and cancelling review restores sentence input',()=>{
  const a=app(),before=a.data('currentState()');
  a.run('openManualNoteEditor()');a.nodes.get('manualContentInput').value='';
  a.run('addManualNote()');assert.equal(a.run('activeModalId'),'noteComposerModal');
  assert.deepEqual(a.data('currentState()'),before);
  a.run('cancelManualEdit()');assert.equal(a.nodes.get('noteDraftEntry').hidden,false);
  assert.equal(a.nodes.get('manualNoteEditor').hidden,true);
});

test('editing a saved note opens its sheet and closing it leaves the saved record intact',()=>{
  const a=app({now:'2026-10-28T09:00:00+09:00'});
  a.run("manualNotes=[{date:'2026-10-28',line:'디스미어 12',text:'옥사멧 점검',kind:'schedule'}];editManualNote(0)");
  assert.equal(a.run('activeModalId'),'noteComposerModal');
  assert.equal(a.nodes.get('noteDraftEntry').hidden,true);
  a.nodes.get('manualContentInput').value='인써트 교체';
  a.run("closeModal('noteComposerModal');openNoteComposer()");
  assert.equal(a.nodes.get('manualContentInput').value,'인써트 교체');
  assert.equal(a.run('manualNotes[0].text'),'옥사멧 점검');
});

test('the time supplement is removed and a dated replacement notice can complete PM',()=>{
  const a=app({now:'2026-10-03T12:00:00+09:00'});
  assert.doesNotMatch(html,/id="(?:kakaoTimeDetails|kakaoMessageTime)"|날짜·시각 보완/);
  a.parse('2026년 10월 2일\n22시 백라이트 입니다\n화8 PM\n이상입니다');
  a.parse('화학동8 양산 진행하겠습니다');
  assert.equal(a.nodes.get('kakaoRawInput').value,'');
  assert.equal(a.run('chemList[1].status'),'시작');
  a.parse('2026년 10월 3일\n화학동8 10:20 양산 진행하겠습니다');
  assert.equal(a.run('chemList[1].status'),'완료');
  assert.equal(a.nodes.get('kakaoRawInput').value,'');
});

test('compact pulse banner prioritizes overdue then nearest dates without dropping reminders',()=>{
  const a=app();
  a.run("activePulseReminds=['전20 · 10/30 확정 · D-2','전9 · 10/25 · D+3 초과','전21 · 11/25 예정 · D-28'];checkPulseBannerTrigger()");
  assert.match(a.nodes.get('remindBannerText').innerHTML,/전9 · 10\/25 · D\+3/);
  assert.match(a.nodes.get('remindBannerText').innerHTML,/외 2건/);
  assert.equal(a.run('activePulseReminds.length'),3);
  a.run("activePulseReminds=['전21 · 11/25 예정 · D-28','전20 · 10/30 확정 · D-2'];checkPulseBannerTrigger()");
  assert.match(a.nodes.get('remindBannerText').innerHTML,/전20/);
});

test('keyboard viewport changes hide the dock and size the sheet without altering records',()=>{
  const a=app(),classes=new Set(),vars={};
  a.context.document.body.classList={add:value=>classes.add(value),remove:value=>classes.delete(value)};
  a.context.document.body.style.setProperty=(key,value)=>{vars[key]=value;};
  a.context.window.innerHeight=844;
  a.context.window.visualViewport={height:480,offsetTop:20};
  const before=a.data('currentState()');a.run('syncMobileKeyboard()');
  assert.equal(classes.has('keyboard-open'),true);assert.equal(vars['--viewport-height'],'480px');assert.equal(vars['--viewport-top'],'20px');
  a.context.window.visualViewport.height=844;a.run('syncMobileKeyboard()');
  assert.equal(classes.has('keyboard-open'),false);assert.deepEqual(a.data('currentState()'),before);
});

test('all consumed pastes release the keyboard and clear while reporting once',()=>{
  const a=app({now:'2026-10-28T09:00:00+09:00'});let blurs=0;
  a.nodes.get('kakaoRawInput').blur=()=>{blurs++;};
  a.parse('2026년 10월 28일\n1시 백라이트 입니다\n화9 PM\n이상입니다.');
  assert.equal(blurs,1);assert.equal(a.nodes.get('kakaoRawInput').value,'');
  assert.match(a.nodes.get('kakaoParseResult').textContent,/공지 반영 완료/);
  assert.doesNotMatch(a.nodes.get('kakaoParseResult').textContent,/0건/);
  assert.notEqual(a.nodes.get('uiToast').style.display,'block');
  a.parse('화9 양산 진행하겠습니다');
  assert.equal(blurs,2);assert.equal(a.nodes.get('kakaoRawInput').value,'');
  assert.match(a.nodes.get('kakaoParseResult').textContent,/제외/);
});

function transferApp(options={}) {
  const a=app(options);
  Object.assign(a.context,{crypto:require('node:crypto').webcrypto,TextEncoder,File:require('node:buffer').File});
  return a;
}
async function archiveText(a) {return JSON.stringify(await a.run('createTransferArchive()'));}
async function chooseArchive(a,text) {await a.run('readTransferFile')( {size:Buffer.byteLength(text),text:async()=>text} );}

test('file transfer preserves all PM records, typed schedules and timers across isolated installations and reload',async()=>{
  const source=transferApp({now:'2026-10-28T09:00:00+09:00'});
  source.run("manualNotes=[{date:'2026-10-30',line:'전기동 20',text:'액퍼내기 확정',kind:'pulse-plan'},{date:'2026-10-28',line:'전기동 12',text:'PM 목요일로 변경',kind:'pm-rule',weekday:4,intervalWeeks:2},{date:'2026-10-28',line:'디스미어 12',text:'옥사멧 점검',kind:'schedule'}];equipWorkFlags={'2026-10-28_디스미어 12':true};pulseProcessFlags={'2026-10-28_전기동 9라인':{isStarted:true,startedAt:'2026-10-28T06:00'}};elecCompletedFlags={'2026-10-27_전기동 11라인':{completedAt:'2026-10-27T19:30'}};inlineDesmearFlags={preserved:{version:2,lineId:'디13',completedAt:'2026-10-28T07:30'}};savePMData()");
  const exported=await archiveText(source),expected=source.data('currentState()');
  const dest=transferApp({stored:{},now:'2026-10-28T09:00:00+09:00'}),original=dest.data('currentState()');
  const storedBefore=Object.fromEntries(dest.storage);
  await chooseArchive(dest,exported);
  assert.equal(dest.nodes.get('transferPreview').hidden,false);
  assert.deepEqual(dest.data('currentState()'),original);assert.deepEqual(Object.fromEntries(dest.storage),storedBefore);
  await dest.run('applyTransferFile()');
  assert.deepEqual(dest.data('currentState()'),expected);
  assert.deepEqual(JSON.parse(dest.storage.get('pm_before_transfer_master')).state,original);
  assert.equal(dest.nodes.get('transferPreview').hidden,true);
  const reload=transferApp({stored:Object.fromEntries(dest.storage),now:'2026-10-28T09:00:00+09:00'});
  assert.deepEqual(reload.data('currentState()'),expected);
  assert.equal(reload.nodes.get('transferUndoButton').hidden,false);
  assert.equal(reload.run("formatDateOnly(getPulseSchedule(pulseList[1]).due)"),'2026-10-30');
  assert.match(reload.nodes.get('shareTextOutput').value,/디12 기본PM \(옥사멧 점검\)/);
});

test('transfer keeps intentionally unknown chemistry and deleted note arrays instead of destination records',async()=>{
  const source=transferApp({stored:{}}),dest=transferApp();
  dest.run("manualNotes=[{date:'2026-10-01',line:'디스미어 12',text:'인써트 교체'}];savePMData()");
  await chooseArchive(dest,await archiveText(source));await dest.run('applyTransferFile()');
  assert.equal(dest.run('chemList.every(item=>item.needsReview)'),true);
  assert.deepEqual(dest.data('manualNotes'),[]);
  const reload=transferApp({stored:Object.fromEntries(dest.storage)});
  assert.equal(reload.run('chemList.every(item=>item.needsReview)'),true);assert.deepEqual(reload.data('manualNotes'),[]);
});

test('transfer rejects malformed, incomplete, duplicate-line and checksum-damaged files without writes',async()=>{
  const a=transferApp(),baseline=a.data('currentState()'),storedBefore=Object.fromEntries(a.storage);
  const good=JSON.parse(await archiveText(a));
  const bad=[];
  bad.push('not JSON',JSON.stringify({format:'other'}));
  for(const modify of [p=>{delete p.state.manualNotes;},p=>{p.state.chemList[1].id='화7';},p=>{p.state.pulseList[0].lastDate='2026-02-30';},p=>{p.state.manualNotes=[{date:'2026-10-01',line:'디12'}];},p=>{p.state.elecDummyFlags=[];},p=>{p.state.chemList[0].lastDone='wrong';},p=>{p.state.chemList[0].note='changed after backup';}]) {
    const changed=structuredClone(good);modify(changed);bad.push(JSON.stringify(changed));
  }
  for(const text of bad) {
    await chooseArchive(a,text);assert.equal(a.nodes.get('transferPreview').hidden,true);
    await a.run('applyTransferFile()');assert.deepEqual(a.data('currentState()'),baseline);assert.deepEqual(Object.fromEntries(a.storage),storedBefore);
  }
});

test('oversized transfer files are refused before reading and cancelled async previews cannot reappear',async()=>{
  const a=transferApp();let reads=0;
  await a.run('readTransferFile')({size:6*1024*1024,text:async()=>{reads++;return '';}});assert.equal(reads,0);
  const text=await archiveText(a);let finish;
  const pending=a.run('readTransferFile')({size:text.length,text:()=>new Promise(resolve=>{finish=resolve;})});
  a.run('cancelTransferPreview()');finish(text);await pending;
  assert.equal(a.nodes.get('transferPreview').hidden,true);assert.equal(a.run('pendingTransfer'),null);
});

test('previous installation records can be previewed after reload and restored only with explicit apply',async()=>{
  const source=transferApp({stored:{}}),dest=transferApp(),previous=dest.data('currentState()');
  await chooseArchive(dest,await archiveText(source));await dest.run('applyTransferFile()');
  const reload=transferApp({stored:Object.fromEntries(dest.storage)}),current=reload.data('currentState()');
  await reload.run('previewPreviousTransfer()');assert.deepEqual(reload.data('currentState()'),current);
  assert.match(reload.nodes.get('transferApplyButton').textContent,/되돌리기/);
  await reload.run('applyTransferFile()');assert.deepEqual(reload.data('currentState()'),previous);
});

test('transfer aborts safely when previous-snapshot or primary storage writes fail',async()=>{
  const source=transferApp({stored:{}}),text=await archiveText(source);
  for(const key of ['pm_before_transfer_master','pm_local_state_master']) {
    const dest=transferApp(),baseline=dest.data('currentState()'),saved=dest.storage.get('pm_local_state_master');
    await chooseArchive(dest,text);const original=dest.context.localStorage.setItem;
    dest.context.localStorage.setItem=(name,value)=>{if(name===key)throw Error('quota');original(name,value);};
    await dest.run('applyTransferFile()');assert.deepEqual(dest.data('currentState()'),baseline);
    assert.equal(dest.storage.get('pm_local_state_master'),saved);
    assert.equal(dest.nodes.get('transferPreview').hidden,false);assert.match(dest.nodes.get('transferResult').textContent,/저장 공간/);
  }
});

test('unrelated pasted conversations and browser credentials are absent from transfer files',async()=>{
  const a=transferApp();a.nodes.get('kakaoRawInput').value='private raw conversation';
  a.storage.set('unrelated_credentials','private auth secret');
  const text=await archiveText(a);assert.doesNotMatch(text,/private raw conversation|private auth secret|unrelated_credentials|apiKey/);
  assert.deepEqual(Object.keys(JSON.parse(text).state),a.data('STATE_FIELDS'));
});

test('record changes during async apply abort replacement and overlapping apply requests run once',async()=>{
  const source=transferApp({stored:{}}),dest=transferApp(),text=await archiveText(source);
  await chooseArchive(dest,text);
  const actual=dest.context.crypto;let resume,requests=0;
  dest.context.crypto={subtle:{digest:(...args)=>{requests++;return new Promise(resolve=>{resume=()=>actual.subtle.digest(...args).then(resolve);});}}};
  const first=dest.run('applyTransferFile()');await dest.run('applyTransferFile()');assert.equal(requests,1);
  dest.run("chemList[0].note='newer local note'");resume();
  // The second digest builds the safety copy; complete it too.
  await new Promise(resolve=>setImmediate(resolve));
  while(requests===1) await new Promise(resolve=>setImmediate(resolve));
  resume();await first;
  assert.equal(dest.run('chemList[0].note'),'newer local note');assert.match(dest.nodes.get('transferResult').textContent,/기록이 바뀌/);
  assert.equal(dest.storage.has('pm_before_transfer_master'),false);
});

test('file save uses native sharing with cancellation, then falls back to a local download if unavailable',async()=>{
  const a=transferApp(),baseline=a.data('currentState()');let shares=0,downloads=0,downloadFile;
  a.context.navigator.canShare=()=>true;
  a.context.navigator.share=async({files})=>{shares++;assert.equal(files.length,1);assert.equal(JSON.parse(await files[0].text()).format,'pm-local-transfer');};
  await a.run('saveTransferFile()');assert.equal(shares,1);assert.deepEqual(a.data('currentState()'),baseline);
  a.context.navigator.share=async()=>{const error=Error('cancel');error.name='AbortError';throw error;};
  await a.run('saveTransferFile()');assert.match(a.nodes.get('transferResult').textContent,/취소/);
  a.context.URL={createObjectURL:file=>{downloadFile=file;return 'blob:local-transfer';},revokeObjectURL:()=>{}};
  a.context.document.createElement=()=>({click(){downloads++;},remove(){}});
  a.context.navigator.share=async()=>{const error=Error('blocked');error.name='NotAllowedError';throw error;};
  await a.run('saveTransferFile()');assert.equal(downloads,1);
  assert.match(downloadFile.name,/^PM-backup-.*\.json$/);assert.equal(JSON.parse(await downloadFile.text()).sha256.length,64);
  assert.match(a.nodes.get('transferResult').textContent,/다운로드를 요청/);assert.deepEqual(a.data('currentState()'),baseline);
});

test('a system share sheet that never resolves cannot leave transfer controls locked',async()=>{
  const a=transferApp();let shareOpened;
  const opened=new Promise(resolve=>{shareOpened=resolve;});
  a.context.navigator.canShare=()=>true;
  a.context.navigator.share=()=>{shareOpened();return new Promise(()=>{});};
  a.run('saveTransferFile()');await opened;
  assert.equal(a.run('transferBusy'),false);
  assert.equal(a.nodes.get('transferSaveButton').disabled,false);
  assert.equal(a.nodes.get('transferLoadButton').disabled,false);
});

test('input-only native paste applies once, clears and opens the notice preview',()=>{
  const a=app();a.nodes.get('noticeDetails').open=false;
  a.nodes.get('kakaoRawInput').value='화13 07:17 촉매 건욕 PM 진행중';
  a.run("handleKakaoInput({inputType:'insertFromPaste'})");a.timers.at(-1)();
  assert.equal(a.run('new Date(chemList[3].lastDone).getMinutes()'),17);
  assert.equal(a.nodes.get('kakaoRawInput').value,'');assert.equal(a.nodes.get('kakaoApplyButton').hidden,true);
  assert.equal(a.nodes.get('noticeDetails').open,true);
  assert.equal(a.run('kakaoPastePending'),false);
});

test('paste and input events together cannot apply the same clipboard twice or consume typed drafts',()=>{
  const a=app();a.context.pasteCalls=0;
  a.run('const originalPasteParser=parseAndApplyKakaoMsg;parseAndApplyKakaoMsg=function(){pasteCalls++;return originalPasteParser();}');
  a.run('queueKakaoPaste()');const first=a.timers.at(-1);
  a.nodes.get('kakaoRawInput').value='화13 07:17 촉매 건욕 PM 진행중';
  a.run("handleKakaoInput({inputType:'insertFromPaste'})");const second=a.timers.at(-1);
  first();second();assert.equal(a.context.pasteCalls,1);assert.equal(a.nodes.get('kakaoRawInput').value,'');
  const before=a.timers.length;a.nodes.get('kakaoRawInput').value='디12';
  a.run("handleKakaoInput({inputType:'insertCompositionText'})");
  assert.equal(a.nodes.get('kakaoRawInput').value,'디12');assert.equal(a.timers.length,before);
  assert.equal(a.nodes.get('kakaoApplyButton').hidden,false);
});

test('mixed notices apply valid rows, skip missing dates and clear the whole paste',()=>{
  const a=app({now:'2026-10-03T12:00:00+09:00'});
  a.parse('2026년 10월 2일\n22시 백라이트\n화13 PM\n이상입니다');
  const existing=a.data('chemList[3]');
  a.parse('화7 07:17 화학동 건욕 PM 진행중\n화13 액수위입니다');
  assert.equal(a.run('chemList[0].status'),'시작');assert.equal(a.run('new Date(chemList[0].lastDone).getMinutes()'),17);
  assert.deepEqual(a.data('chemList[3]'),existing);
  assert.equal(a.nodes.get('kakaoRawInput').value,'');
  assert.match(a.nodes.get('kakaoParseResult').textContent,/반영 완료.*1건.*1건은 제외/);
});

test('transfer mode selection presents one task at a time without writing records',()=>{
  const a=transferApp(),before=a.data('currentState()'),stored=Object.fromEntries(a.storage);
  assert.equal(a.nodes.get('transferSavePanel').hidden,false);assert.equal(a.nodes.get('transferLoadPanel').hidden,true);
  a.run("selectTransferMode('load')");
  assert.equal(a.nodes.get('transferSavePanel').hidden,true);assert.equal(a.nodes.get('transferLoadPanel').hidden,false);
  a.run("selectTransferMode('save')");
  assert.equal(a.nodes.get('transferSavePanel').hidden,false);assert.equal(a.nodes.get('transferLoadPanel').hidden,true);
  assert.deepEqual(a.data('currentState()'),before);assert.deepEqual(Object.fromEntries(a.storage),stored);
});

test('transfer preview replaces the chooser, preserves its draft across modes and resets on cancellation',async()=>{
  const a=transferApp();await chooseArchive(a,await archiveText(a));
  assert.equal(a.nodes.get('transferLoadPanel').hidden,false);assert.equal(a.nodes.get('transferFileChoice').hidden,true);
  assert.equal(a.nodes.get('transferChemDetails').open,false);assert.equal(a.nodes.get('transferChemCount').textContent,'5/5');
  assert.equal(a.nodes.get('transferNoteCount').textContent,'0');assert.equal(a.nodes.get('transferPulseCount').textContent,'4');
  a.run("selectTransferMode('save');selectTransferMode('load')");
  assert.equal(a.nodes.get('transferPreview').hidden,false);assert.equal(a.nodes.get('transferFileChoice').hidden,true);
  a.run('cancelTransferPreview()');
  assert.equal(a.nodes.get('transferPreview').hidden,true);assert.equal(a.nodes.get('transferFileChoice').hidden,false);
});

test('restore completion gives a review action while a later file attempt resets old success feedback',async()=>{
  const a=transferApp();await chooseArchive(a,await archiveText(a));await a.run('applyTransferFile()');
  assert.equal(a.nodes.get('transferDoneAction').hidden,false);assert.equal(a.nodes.get('transferFileChoice').hidden,true);
  await chooseArchive(a,'not JSON');
  assert.equal(a.nodes.get('transferDoneAction').hidden,true);assert.equal(a.nodes.get('transferFileChoice').hidden,false);
  assert.equal(a.nodes.get('transferPreview').hidden,true);
});

test('opening data transfer brings the expanded task into view without touching saved data',()=>{
  const a=app(),before=a.data('currentState()');let scroll;
  a.nodes.get('transferTools').scrollIntoView=options=>{scroll=options;};
  a.context.window.matchMedia=()=>({matches:true});a.run('openTransferTools()');
  assert.equal(scroll.block,'start');assert.equal(scroll.behavior,'instant');
  assert.deepEqual(a.data('currentState()'),before);
});
