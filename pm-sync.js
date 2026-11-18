(function(root,factory) {
  const api=factory(root);
  if(typeof module==='object' && module.exports) module.exports=api;
  else root.createPMSync=api.createPMSync;
})(typeof globalThis!=='undefined'?globalThis:this,function(root) {
  'use strict';

  const PENDING_KEY='pm_cloud_pending_v1';
  const RECOVERY_PREFIX=PENDING_KEY+':recovery:';
  const BASE_KEY='pm_cloud_base_v1';
  const CONNECTION_KEY='pm_cloud_connection_v1';
  const copy=value=>value==null?value:JSON.parse(JSON.stringify(value));
  const object=value=>!!value && typeof value==='object' && !Array.isArray(value);
  function stable(value) {
    if(Array.isArray(value)) return '['+value.map(stable).join(',')+']';
    if(object(value)) return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}';
    return JSON.stringify(value);
  }
  const same=(a,b)=>stable(a)===stable(b);
  const revisionValid=value=>value===null || typeof value==='string' || (Number.isSafeInteger(value)&&value>=0);
  const uid=()=>root.crypto?.randomUUID?.() || Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)+'-'+Math.random().toString(36).slice(2);

  /* onState is synchronous: return false if the app cannot persist the incoming
     snapshot. tellLocalSave is called only AFTER the app's own successful save.
     No request, timer, credential storage, or app-state mutation occurs at load. */
  function createPMSync(options={}) {
    const storage=options.storage || root.localStorage;
    const fetcher=options.fetch || root.fetch?.bind(root);
    const endpoint=options.endpoint || '/api/pm-sync';
    const onState=options.onState || (()=>true);
    const onStatus=options.onStatus || (()=>{});
    const getLocal=()=>copy(options.getLocalState?.() ?? null);
    const tabId=uid();
    let sequence=0,localVersion=0,sessionVersion=0,serial=Promise.resolve();
    let phase='signed-out',error=null,connected=false,linked=false,base=null,remote=null;
    let timer=null,stopped=false,listening=false,applying=false,pullPromise=null;

    function read(key) {
      try {const value=storage.getItem(key);return value===null?null:JSON.parse(value);} catch(_) {return null;}
    }
    function write(key,value) {
      try {storage.setItem(key,JSON.stringify(value));return true;} catch(_) {error='storage';return false;}
    }
    function validRecord(value) {
      return object(value)&&value.version===1&&typeof value.id==='string'&&typeof value.owner==='string'&&
        Number.isSafeInteger(value.sequence)&&revisionValid(value.revision)&&object(value.state);
    }
    function recoveryEntries(includeArchived=false) {
      const result=[];
      try {
        for(let i=0;i<storage.length;i++) {
          const key=storage.key(i);
          if(key!==PENDING_KEY && !key?.startsWith(RECOVERY_PREFIX)) continue;
          const value=read(key);
          if(validRecord(value)&&(includeArchived||!value.archived)) result.push({key,value});
        }
      } catch(_) {error='storage';}
      return result;
    }
    function records() {
      // Every tab has its own durable slot. A simultaneous write to the shared
      // head can never erase another tab's unsent snapshot.
      const owners=new Map();
      for(const {value} of recoveryEntries(true)) {
        const old=owners.get(value.owner);
        if(!old || value.sequence>old.sequence) owners.set(value.owner,value);
      }
      return [...owners.values()].filter(item=>!item.archived);
    }
    function groups() {
      const result=[];
      for(const item of records()) if(!result.some(other=>same(other.state,item.state)&&same(other.revision,item.revision))) result.push(item);
      return result;
    }
    function currentPending() {
      const all=records();return all.find(item=>item.owner===tabId)||all[0]||null;
    }
    function getStatus() {
      const all=groups();
      return {phase,connected,linked,pending:all.length>0,revision:base?.revision??null,
        canEdit:true,error,conflictCount:all.length};
    }
    function emit(next=phase,code=null) {
      phase=next;error=code;
      try {onStatus(getStatus());} catch(_) { /* App rendering cannot stop storage. */ }
      return getStatus();
    }
    function enqueue(task) {
      const next=serial.then(()=>stopped?getStatus():task());
      serial=next.catch(()=>{});
      return next.catch(err=>handleError(err));
    }
    function storeConnection(enabled) {
      linked=enabled;
      return write(CONNECTION_KEY,{version:1,enabled});
    }
    function storeBase(revision,state) {
      const next={version:1,revision,state:copy(state)};
      if(!write(BASE_KEY,next)) return false;
      base=next;return true;
    }
    function savePending(state,revision=base?.revision??remote?.revision??null,blocked=false) {
      const prior=records().find(item=>item.owner===tabId);
      const next={version:1,id:uid(),owner:tabId,sequence:Math.max(++sequence,(prior?.sequence||0)+1),
        revision,state:copy(state),updatedAt:new Date().toISOString(),blocked:blocked||prior?.blocked===true};
      sequence=next.sequence;
      if(!write(RECOVERY_PREFIX+tabId,next)) return null;
      const head=read(PENDING_KEY);
      if(!validRecord(head)||head.archived||head.owner===tabId) write(PENDING_KEY,next);
      return next;
    }
    function retire(predicate,{archive=false}={}) {
      const selected=records().filter(predicate);
      for(const {key,value} of recoveryEntries()) {
        if(!predicate(value)&&!selected.some(item=>item.owner===value.owner&&value.sequence<=item.sequence)) continue;
        // Do not remove a newer save which appeared after enumeration.
        if(read(key)?.id!==value.id) continue;
        try {
          if(archive && key.startsWith(RECOVERY_PREFIX)) {
            if(!write(key,{...value,archived:true})) return false;
          } else storage.removeItem(key);
        } catch(_) {error='storage';return false;}
      }
      return true;
    }
    function snapshots() {
      return records().map(item=>({id:item.id,revision:item.revision,state:copy(item.state)}));
    }
    function apply(state,revision,reason,expectedLocal,expectedVersion) {
      if(expectedVersion!==localVersion || !same(getLocal(),expectedLocal)) return false;
      applying=true;
      let result;
      try {result=onState(copy(state),{revision,reason,previousState:copy(expectedLocal),pendingSnapshots:snapshots()});}
      catch(_) {result=false;}
      finally {applying=false;}
      // An asynchronous callback could overwrite a newer user edit later; the
      // integration deliberately uses the app's synchronous local save path.
      if(result===false || result?.then) {error='local-apply-failed';return false;}
      return true;
    }
    function fault(code,status=0) {const err=new Error(code);err.code=code;err.status=status;return err;}
    async function request(method,body,version=sessionVersion) {
      if(!fetcher) throw fault('network');
      const controller=typeof root.AbortController==='function'?new root.AbortController():null;
      const timeout=controller&&root.setTimeout?root.setTimeout(()=>controller.abort(),options.timeoutMs||15000):null;
      let response;
      try {
        response=await fetcher(endpoint,{method,credentials:'same-origin',cache:'no-store',
          ...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),
          ...(controller?{signal:controller.signal}:{})});
      } catch(_) {if(version!==sessionVersion) throw fault('obsolete');throw fault('network');}
      finally {if(timeout!==null) root.clearTimeout?.(timeout);}
      if(version!==sessionVersion) throw fault('obsolete');
      let data;
      try {data=await response.json();} catch(_) {data={};}
      if(version!==sessionVersion) throw fault('obsolete');
      if(!response.ok) throw fault(typeof data.error==='string'?data.error:'http-error',response.status);
      return data;
    }
    function handleError(err,login=false) {
      if(err?.code==='obsolete') return getStatus();
      if(err?.status===401) {connected=false;return emit(login?'login-error':'signed-out','unauthorized');}
      if(err?.status===503&&['sync_unavailable','disabled'].includes(err.code)) {connected=false;return emit('disabled','disabled');}
      if(err?.status===409) return emit('conflict','revision-conflict');
      return emit(err?.code==='network'?'offline':login?'login-error':'error',err?.code||'request-failed');
    }
    function validateRemote(data) {
      if(!object(data)||!revisionValid(data.revision)||
        (data.revision===null?data.state!==null:!object(data.state))) throw fault('invalid-response');
      return {revision:data.revision,state:copy(data.state)};
    }
    function protectChangedLocal(expected,expectedVersion,revision) {
      const local=getLocal();
      if(expectedVersion===localVersion&&same(local,expected)) return false;
      // A just-observed revision is not the base of an edit made before joining.
      // In particular, a startup edit must never turn into a blind cloud replace.
      if(object(local)) savePending(local,base?.revision??null);
      emit('conflict','local-changed');return true;
    }
    function finishPhase() {
      const remaining=groups();
      if(remaining.length>1) return emit('conflict','other-tab');
      if(remaining.length) return emit('pending');
      return emit('ready');
    }
    async function reconcile(reason='pull',{flush=true}={}) {
      const version=sessionVersion,startVersion=localVersion,local=getLocal();
      const data=validateRemote(await request('GET',undefined,version));
      connected=true;remote=data;
      if(data.revision===null) {
        if(protectChangedLocal(local,startVersion,null)) return getStatus();
        return emit('uninitialized'); // Never seed from startup or an offline queue.
      }
      if(protectChangedLocal(local,startVersion,data.revision)) return getStatus();
      let pending=groups();
      if(pending.length) {
        // A committed response may have been lost. Identical cloud content is a
        // successful acknowledgement, not a conflict or a second completion.
        const identical=pending.filter(item=>same(item.state,data.state));
        if(identical.length) {
          if(!storeBase(data.revision,data.state)) return emit('error','storage');
          const ids=new Set(identical.map(item=>item.id));
          if(!retire(item=>ids.has(item.id)||same(item.state,data.state))) return emit('error','storage');
          pending=groups();
        }
        if(pending.length>1) return emit('conflict','other-tab');
        if(pending.length) {
          const item=pending[0];
          if(item.blocked) return emit('conflict','local-pending-differ');
          if(!same(item.revision,data.revision)) return emit('conflict','revision-conflict');
          if(!same(local,item.state)) return emit('conflict','local-pending-differ');
          return flush?flushPending():emit('pending');
        }
        if(!same(local,data.state)) {
          if(object(local)&&!savePending(local,data.revision,true)) return emit('error','storage');
          return emit('conflict','local-pending-differ');
        }
        return emit('ready');
      }
      // A known browser may have edited while signed out, before the controller
      // loaded, or between two network requests. Preserve it before any pull.
      if(object(local)&&!same(local,data.state)&&base&&!same(local,base.state)) {
        if(!savePending(local,base?.revision??null)) return emit('error','storage');
        return emit('conflict','local-pending-differ');
      }
      if(!same(local,data.state)) {
        if(!apply(data.state,data.revision,reason,local,startVersion)) return emit('error',error||'local-changed');
      }
      if(!storeBase(data.revision,data.state)) return emit('error','storage');
      return emit('ready');
    }
    async function flushPending() {
      if(!connected || !linked) return getStatus();
      let pending=groups();
      if(pending.length>1) return emit('conflict','other-tab');
      if(!pending.length) return emit(remote?.revision===null?'uninitialized':'ready');
      const sent=pending[0];
      if(sent.blocked) return emit('conflict','local-pending-differ');
      if(sent.revision===null) return emit(remote?.revision===null?'uninitialized':'conflict','initial-choice-required');
      if(remote && !same(sent.revision,remote.revision)) return emit('conflict','revision-conflict');
      const version=sessionVersion;
      emit('syncing');
      let result;
      try {result=await request('PUT',{revision:sent.revision,state:sent.state},version);}
      catch(err) {return handleError(err);}
      if(!revisionValid(result.revision)||result.revision===null) return emit('error','invalid-response');
      remote={revision:result.revision,state:copy(sent.state)};
      if(!storeBase(result.revision,sent.state)) return emit('error','storage');
      // Later edits from THIS tab can follow our acknowledged save. Another
      // tab's different snapshot must never be silently rebased over it.
      const newer=records().find(item=>item.owner===tabId&&item.id!==sent.id);
      if(newer && sent.owner===tabId && same(newer.revision,sent.revision)) {
        if(!savePending(newer.state,result.revision)) return emit('error','storage');
      }
      if(!retire(item=>item.id===sent.id || same(item.state,sent.state))) return emit('error','storage');
      pending=groups();
      if(pending.length===1&&same(pending[0].revision,result.revision)) return flushPending();
      return finishPhase();
    }
    function tellLocalSave(state) {
      if(applying || !object(state)) return Promise.resolve(getStatus());
      localVersion++;
      if(!linked&&!records().length) return Promise.resolve(getStatus());
      const previous=records().find(item=>item.owner===tabId);
      if(!previous&&!records().length&&base&&same(state,base.state)) return Promise.resolve(getStatus());
      if(!savePending(state,previous?.revision??base?.revision??remote?.revision??null)) return Promise.resolve(emit('error','storage'));
      if(groups().length>1 || phase==='conflict') return Promise.resolve(emit('conflict','other-tab'));
      if(!connected) return Promise.resolve(emit(phase==='disabled'?'disabled':'signed-out',error));
      emit('pending');return enqueue(flushPending);
    }
    function initialize() {
      const marker=read(CONNECTION_KEY),saved=read(BASE_KEY);
      linked=marker?.version===1&&marker.enabled===true;
      if(saved?.version===1&&revisionValid(saved.revision)&&object(saved.state)) base=saved;
      if(marker?.version===1&&marker.enabled===false) return Promise.resolve(emit('signed-out'));
      emit('loading');return enqueue(async()=>{
        try {return await reconcile('join');} catch(err) {return handleError(err);}
      });
    }
    function login(accessCode) {
      const version=++sessionVersion;
      emit('loading');
      return enqueue(async()=>{
        try {
          await request('POST',{action:'login',accessCode:String(accessCode||'')},version);
          accessCode='';connected=true;
          if(!storeConnection(true)) return emit('error','storage');
          return await reconcile('join');
        } catch(err) {return handleError(err,true);}
        finally {accessCode='';}
      });
    }
    function seed(state=getLocal()) {
      const snapshot=copy(state);
      return enqueue(async()=>{
        if(!connected||!linked) return emit('signed-out','unauthorized');
        if(!remote||remote.revision!==null) return emit('conflict','initial-choice-required');
        if(!object(snapshot)) return emit('error','invalid-state');
        const local=getLocal(),before=localVersion,version=sessionVersion;
        if(!apply(snapshot,null,'seed',local,before)) return emit('error',error||'local-apply-failed');
        const sent=savePending(snapshot,null);
        if(!sent) return emit('error','storage');
        emit('syncing');
        let result;
        try {result=await request('PUT',{revision:null,state:snapshot},version);} catch(err) {return handleError(err);}
        if(!revisionValid(result.revision)||result.revision===null) return emit('error','invalid-response');
        remote={revision:result.revision,state:copy(snapshot)};
        if(!storeBase(result.revision,snapshot)) return emit('error','storage');
        const newer=records().find(item=>item.owner===tabId&&item.id!==sent.id);
        if(newer&&!savePending(newer.state,result.revision)) return emit('error','storage');
        if(!retire(item=>item.id===sent.id||same(item.state,snapshot))) return emit('error','storage');
        return groups().length?flushPending():emit('ready');
      });
    }
    function pull() {
      if(!linked) return Promise.resolve(getStatus());
      if(pullPromise) return pullPromise;
      pullPromise=enqueue(async()=>{try {return await reconcile('pull');} catch(err) {return handleError(err);}})
        .finally(()=>{pullPromise=null;});
      return pullPromise;
    }
    function retry() {return pull();}
    function acceptRemote() {
      return enqueue(async()=>{
        if(!linked) return getStatus();
        const local=getLocal(),before=localVersion,version=sessionVersion;
        const pendingIds=new Set(records().map(item=>item.id));
        let data;
        try {data=validateRemote(await request('GET',undefined,version));} catch(err) {return handleError(err);}
        connected=true;remote=data;
        if(data.revision===null) return emit('uninitialized');
        if(protectChangedLocal(local,before,data.revision)) return getStatus();
        if(records().some(item=>!pendingIds.has(item.id))) return emit('conflict','other-tab');
        if(!apply(data.state,data.revision,'conflict',local,before)) return emit('error',error||'local-apply-failed');
        if(!storeBase(data.revision,data.state)) return emit('error','storage');
        // Keep durable recovery copies, but stop offering them for upload.
        if(!retire(item=>pendingIds.has(item.id),{archive:true})) return emit('error','storage');
        return finishPhase();
      });
    }
    function disconnect() {
      ++sessionVersion;connected=false;
      storeConnection(false);emit('signed-out');
      return enqueue(async()=>{
        try {await request('DELETE');return emit('signed-out');}
        catch(err) {return emit('signed-out',err.code==='network'?'logout-pending':err.code);}
      });
    }
    function visible() {return !root.document || root.document.visibilityState!=='hidden';}
    function wake() {if(visible()&&linked) void pull();}
    function storageChanged(event) {
      if(!event?.key || event.key===PENDING_KEY || event.key.startsWith(RECOVERY_PREFIX)) {
        if(groups().length>1) emit('conflict','other-tab');
      }
      if(event?.key===BASE_KEY || event?.key===CONNECTION_KEY) wake();
    }
    function startPolling(intervalMs=90000) {
      if(stopped) return;
      if(timer!==null) root.clearInterval?.(timer);
      timer=root.setInterval?.(wake,Math.max(60000,intervalMs))??null;
      if(!listening) {
        root.addEventListener?.('focus',wake);root.addEventListener?.('online',wake);
        root.addEventListener?.('storage',storageChanged);root.document?.addEventListener?.('visibilitychange',wake);
        listening=true;
      }
    }
    function stop() {
      stopped=true;++sessionVersion;
      if(timer!==null) root.clearInterval?.(timer);timer=null;
      root.removeEventListener?.('focus',wake);root.removeEventListener?.('online',wake);
      root.removeEventListener?.('storage',storageChanged);root.document?.removeEventListener?.('visibilitychange',wake);
      listening=false;
    }
    return {initialize,login,seed,tellLocalSave,pull,retry,acceptRemote,disconnect,getStatus,startPolling,stop,
      getPendingState:()=>copy(currentPending()?.state??null),
      getRecoverySnapshots:()=>recoveryEntries(true).filter(item=>item.key.startsWith(RECOVERY_PREFIX)).map(item=>copy(item.value))};
  }
  return {createPMSync};
});
