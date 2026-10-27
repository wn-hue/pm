// Run: node --test tests/pm-regression.cjs
// DOM and browser storage are isolated test doubles. No network access is available.
process.env.TZ = 'Asia/Seoul';
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

module.exports = {app};
