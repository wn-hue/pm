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
    const node=new Element(match[1]);node.hidden=/\bhidden\b/.test(match[0]);nodes.set(match[1],node);
  }
  // Compatibility targets for persisted timer rules; these do not exist in the app UI.
  for(const id of ['elecGaugesContainer','activeChemGaugesContainer','elecTodayLinesBadge','btnRestoreElec','chemListContainer']) nodes.set(id,new Element(id));
  nodes.get('passTimeInput').value='7시패스';
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

test('PM evidence survives reload; completion requires time and retains input for correction',()=>{
  const a=app({now:'2026-10-03T12:00:00+09:00'});
  a.parse('2026년 10월 2일\n22시 빽라이트 입니다\n화13 PM\n이상입니다');
  const b=app({stored:Object.fromEntries(a.storage),now:'2026-10-03T12:00:00+09:00'});
  b.parse('화학동13 액수위입니다');
  assert.equal(b.run('chemList[3].status'),'시작');
  assert.equal(b.nodes.get('kakaoRawInput').value,'화학동13 액수위입니다');
  b.nodes.get('kakaoMessageTime').value='2026-10-03T10:20';
  b.run('parseAndApplyKakaoMsg()');
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

test('completion needs a calendar date and uses manual time when copied date is missing',()=>{
  const a=app({now:'2026-10-03T12:00:00+09:00'});
  a.parse('2026년 10월 2일\n22시 빽라이트 입니다\n화8 PM\n이상입니다');
  a.parse('[작업자] [오전 10:20] 화8 액수위입니다');
  assert.equal(a.run('chemList[1].status'),'시작');
  a.nodes.get('kakaoMessageTime').value='2026-10-03T10:20';
  a.run('parseAndApplyKakaoMsg()');
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
  assert.match(a.nodes.get('remindBannerText').innerHTML,/전기동 9라인/);
  assert.equal(a.nodes.get('remindBanner').style.display,'flex');
  a.setNow('2026-10-29T12:00:00+09:00');a.nodes.get('pulseTableBody').children=[];a.run('renderPulseTable()');
  assert.match(a.nodes.get('pulseTableBody').children[0].innerHTML,/D-Day/);
  a.setNow('2026-10-30T12:00:00+09:00');a.run('renderPulseTable()');assert.match(a.nodes.get('remindBannerText').innerHTML,/D\+1/);
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
  assert.match(cards,/화13 13시 PM 진행중/);
  assert.match(cards,/&lt;img/);assert.doesNotMatch(cards,/<img/);
  assert.match(a.nodes.get('shareTextOutput').value,/화13 13시 PM 진행중/);
  assert.equal(a.nodes.get('kakaoPanel').open,false);
  assert.match(a.nodes.get('uiToast').textContent,/반영 완료/);
});

test('attention boundaries stay correct and saved custom passes migrate to fixed seven oclock',()=>{
  const a=app();
  assert.equal(a.run("chemAttention({status:'시작',lastDone:new Date(Date.now()-14*3600000).toISOString()})"),'late');
  assert.equal(a.run("chemAttention({status:'완료',lastDone:new Date(Date.now()-65*3600000).toISOString()})"),'warn');
  a.nodes.get('passTimeInput').value='7시30분패스';a.run('savePassPreference()');
  const b=app({stored:Object.fromEntries(a.storage)});
  assert.equal(b.nodes.get('passTimeInput').value,'7시패스');
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
  a.run("openInlineManualEntry('화14');addInlinePMRecord()");
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
  a.run("openInlineManualEntry('화13');addInlinePMRecord()");
  assert.equal(a.run("getInlineCycle('화13').count"),0);
  assert.equal(a.run("getInlineDue('화13')"),null);
  a.run("removeManualNote(1);removeManualNote(0)");
  assert.equal(a.run("getInlineCycle('화13')"),null);
});


test('inline entry shortcut selects line and default PM without saving anything',()=>{
  const a=app();a.run("openInlineManualEntry('화14')");
  assert.equal(a.nodes.get('inlinePMLine').value,'디스미어 14');
  assert.equal(a.nodes.get('inlinePMDate').value,'2026-10-01');
  assert.equal(a.nodes.get('inlinePMWork').value,'기본PM');
  assert.deepEqual(a.data('manualNotes'),[]);
  assert.match(a.run("inlineControlsHtml('화14')"),/디스미어 PM 입력/);
  assert.doesNotMatch(a.run("inlineControlsHtml('화14')"),/select|횟수/);
});

test('manually registered inline PM appears only on entered date and survives reload',()=>{
  const a=app();a.run("openInlineManualEntry('화13')");
  a.nodes.get('inlinePMDate').value='2026-10-02';a.nodes.get('inlinePMWork').value='10시 스웰러 건욕';
  const chemistry=a.data('chemList');a.run('addInlinePMRecord()');
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

test('inline PM records use their own PM form and deduplicate without entering special notes',()=>{
  const a=app();a.run("openInlineManualEntry('화13');addInlinePMRecord();addInlinePMRecord()");
  assert.equal(a.data('manualNotes').length,1);
  assert.equal(a.nodes.get('manualNoteList').hidden,true);
  assert.equal(a.nodes.get('inlinePMEntry').open,true);
  assert.match(a.nodes.get('inlinePMHistory').innerHTML,/기본PM/);
  assert.equal(a.nodes.get('shareTextOutput').value.split('디스미어 13').length-1,1);
  assert.match(a.nodes.get('inline_cell_4').innerHTML,/기본PM/);
});

test('Kakao desmear notices require manual registration while chemistry aliases still update',()=>{
  const a=app();const original=a.data('chemList');
  a.parse('디화13 12:20 디스미어 PM 스웰러 건욕\n디14 13시 망간 건욕');
  assert.deepEqual(a.data('chemList'),original);assert.deepEqual(a.data('manualNotes'),[]);
  assert.deepEqual(a.data('inlineDesmearFlags'),{});
  assert.match(a.nodes.get('uiToast').textContent,/첫 화면의 PM 기록/);
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
  assert.match(a.nodes.get('focusSummary').innerHTML,/진행 중 0개/);
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
  assert.equal(a.nodes.get('passTimeInput').value,'7시패스');
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

test('inline notice input preserves draft when folded and folds after a successful import',()=>{
  const a=app();
  a.nodes.get('kakaoRawInput').value='화8 07:17 화학동 건욕 완료';
  a.run('openNoticePanel()');
  assert.equal(a.nodes.get('kakaoPanel').open,true);
  assert.notEqual(a.run('document.body.style.position'),'fixed');
  a.nodes.get('kakaoPanel').open=false;
  assert.equal(a.nodes.get('kakaoRawInput').value,'화8 07:17 화학동 건욕 완료');
  a.run('openNoticePanel();parseAndApplyKakaoMsg()');
  assert.equal(a.nodes.get('kakaoPanel').open,false);
  assert.equal(a.run('new Date(chemList[1].lastDone).getMinutes()'),17);
});

test('an incomplete message stays in the inline notice box and opens the missing time field',()=>{
  const a=app({now:'2026-10-03T12:00:00+09:00'});
  a.parse('2026년 10월 2일\n22시 백라이트\n화13 PM\n이상입니다');
  a.run('openNoticePanel()');
  a.parse('화13 액수위입니다');
  assert.equal(a.nodes.get('kakaoPanel').open,true);
  assert.equal(a.nodes.get('kakaoRawInput').value,'화13 액수위입니다');
  assert.match(a.nodes.get('kakaoParseResult').textContent,/날짜·시각/);
  assert.equal(a.nodes.get('kakaoTimeDetails').open,true);
});

test('progress screen is removed and its summary links open chemistry management',()=>{
  assert.doesNotMatch(html,/id="(?:tab2|tabBtn2|elecGaugesContainer|activeChemGaugesContainer)"/);
  const a=app();
  for(const id of ['elecGaugesContainer','activeChemGaugesContainer','elecTodayLinesBadge','btnRestoreElec','chemListContainer']) a.nodes.delete(id);
  a.run("safeRenderAll();tick();switchTab('tab2')");
  assert.equal(a.logs.length,0);
  assert.match(a.nodes.get('focusSummary').innerHTML,/openChemManagement\(\)/);
  assert.doesNotMatch(a.nodes.get('focusSummary').innerHTML,/진척/);
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

test('PM home replaces duplicate chemistry navigation and keeps direct controls and timing details',()=>{
  assert.doesNotMatch(html,/id="(?:tab3|tabBtn3|chemListContainer)"/);
  const a=app({now:'2026-10-01T08:00:00+09:00'});
  for(const id of ['chemListContainer','elecGaugesContainer','activeChemGaugesContainer','elecTodayLinesBadge','btnRestoreElec']) a.nodes.delete(id);
  let scrolled=false;a.nodes.get('chemManagement').scrollIntoView=()=>{scrolled=true;};
  a.run("switchTab('tab3');safeRenderAll();tick()");
  assert.equal(scrolled,true);assert.equal(a.logs.length,0);
  const home=a.nodes.get('tab1ChemStatusContainer').innerHTML;
  assert.match(home,/화7 PM 완료/);assert.match(home,/시간정정/);
  assert.match(home,/12시간 액이송/);assert.match(home,/14시간 PM 목표/);assert.match(home,/직전 완료/);
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

test('inline desmear only appears for work or a remembered note in the selected date window',()=>{
  const a=app({stored:{},now:'2026-10-27T08:00:00+09:00'});
  a.run("manualNotes=[{date:'2026-10-01',line:'디스미어 13',text:'기본PM'}];renderInlineDesmearStatus()");
  assert.equal(a.nodes.get('inlineDesmearSection').hidden,true);
  assert.equal(a.nodes.get('inlineDesmearStatusContainer').innerHTML,'');
  a.run("manualNotes.push({date:'2026-10-27',line:'디스미어 14',text:'설비 점검',kind:'schedule'});renderInlineDesmearStatus()");
  assert.equal(a.nodes.get('inlineDesmearSection').hidden,false);
  assert.match(a.nodes.get('inlineDesmearStatusContainer').innerHTML,/디스미어 14/);
  assert.doesNotMatch(a.nodes.get('inlineDesmearStatusContainer').innerHTML,/디스미어 13/);
  a.run("selectQuickDay('tomorrow')");assert.equal(a.nodes.get('inlineDesmearSection').hidden,true);
  a.run("manualNotes=[{date:'2026-10-01',line:'디스미어 13',text:'기본PM'}];inlineDesmearFlags={one:{version:2,lineId:'화13',completedAt:'2026-10-25T10:00:00+09:00'}};chemList[3]={...chemList[3],needsReview:false,status:'완료',lastDone:'2026-10-25T10:00:00+09:00'};renderInlineDesmearStatus()");
  assert.equal(a.nodes.get('inlineDesmearSection').hidden,false);
  assert.match(a.nodes.get('inlineDesmearStatusContainer').innerHTML,/디스미어 13/);
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
  assert.match(a.nodes.get('inlinePMHistory').innerHTML,/기본PM/);
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

test('personal app has no server SDK, login, connection tools, uploader or data-management menu',()=>{
  assert.doesNotMatch(html,/firebase|connectPMServer|syncDataToFirebase|importKakaoEvents|serverLogin|connection-tools|연결 · 데이터 관리|자동 연동 관리|동기화 저장|exportPMBackup|buildPMBackup|\bfetch\s*\(|WebSocket|XMLHttpRequest/i);
  assert.match(html,/Content-Security-Policy" content="connect-src 'none'"/);
  const a=app();let calls=0;
  a.context.firebase={initializeApp:()=>{calls++;throw Error('unexpected connection');}};
  a.context.fetch=()=>{calls++;throw Error('unexpected request');};
  a.run('window.onload();savePMData();tick()');
  assert.equal(calls,0);assert.equal(a.logs.length,0);
  assert.match(a.nodes.get('localSaveStatus').textContent,/개인용.*자동 저장/);
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
