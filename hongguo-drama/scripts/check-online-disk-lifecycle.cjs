// Real file readers, isolated main-process state; no network, app data or GUI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const harness = fs.readFileSync(path.join(__dirname,'check-custom-media-integration.cjs'),'utf8').split('(async()=>{')[0];
function load() {
  const module = {exports:{}};
  vm.runInNewContext(harness + '\nmodule.exports={context,run,handlers,root,vid,sid,native,protocols};', {module,require,__dirname,console,process,Buffer,URL,Response,Request,Headers,AbortController,setTimeout,clearTimeout});
  const h = module.exports;
  h.run("resolveFfmpeg=()=>'/fixture/ffmpeg';probeVideoInfo=async()=>({w:1080,h:1920,duration:2});");
  return h;
}
async function flush() { for (let i=0;i<30;i++) await Promise.resolve(); }
async function waitFor(test) {
  for (let i=0;i<200;i++) { if(test())return; await new Promise(resolve=>setTimeout(resolve,5)); }
  throw new Error('fixture did not reach expected state');
}
(async()=>{
  let failures=0;
  const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(error){failures++;console.error('FAIL '+name+': '+error.message);}};
  await check('shared HLS consumers own the disk file before cache eviction',async()=>{
    const h=load();
    try {
      let finish,file;
      h.context.prepareHlsFile=async(_info,output)=>{file=output;await new Promise(resolve=>finish=resolve);fs.writeFileSync(output,Buffer.alloc(200000));};
      const first=h.handlers['prepare-online-play']({}, {vid:h.vid,seriesId:h.sid,requestId:'first'});
      const second=h.handlers['prepare-online-play']({}, {vid:h.vid,seriesId:h.sid,requestId:'second'});
      while(!finish) await new Promise(setImmediate);
      h.context.originalTrim=h.context.trimOnlineCache;
      h.run(`onlineCache.set('other',{size:ONLINE_MAX_BYTES,lastUsed:Infinity}); allConsumersBound=false;
        trimOnlineCache=()=>{allConsumersBound=[...onlineSessions.values()].every(session=>!!session.entry?.filePath);originalTrim();const first=[...onlineSessions].find(([,session])=>session.requestId==='first');if(first)releaseOnlineSession(first[0]);};`);
      finish();
      const results=await Promise.all([first,second]);
      assert.equal(h.run('allConsumersBound'),true,'cache trimming ran before every shared consumer acquired its file');
      assert.equal(results[1].success,true,results[1].error);
      assert.equal(fs.existsSync(file),true,'eviction and releasing one consumer removed the other consumer file');
      await h.handlers['release-online-play']({}, {requestId:'second'});
      assert.equal(fs.existsSync(file),false,'last uncached consumer must release its disk file');
    } finally {h.context.clearOnlineCache();fs.rmSync(h.root,{recursive:true,force:true});}
  });
  await check('real disk reader pins its file and retries disposal after close',async()=>{
    const h=load(), originalRead=fs.createReadStream, originalRemove=fs.rmSync;
    let reader;
    try {
      const directory=path.join(h.root,'disk');fs.mkdirSync(directory);const file=path.join(directory,'video.mp4');fs.writeFileSync(file,Buffer.alloc(4*1024*1024));
      const entry={filePath:file,size:fs.statSync(file).size,disk:{directory,readers:0}}, session={requests:new Set()};
      fs.createReadStream=(...args)=>{reader=originalRead(...args);return reader;};
      // Model Windows refusing removal of an open file while retaining a real Node reader.
      fs.rmSync=(target,...args)=>{if(target===directory&&!reader.closed)throw Object.assign(new Error('file open'),{code:'EBUSY'});return originalRemove(target,...args);};
      const response=h.context.diskMediaResponse(new Request('https://fixture.example/video'),entry,session);
      assert.equal(entry.disk.readers,1,'stream readers must participate in disk ownership');
      h.context.disposeOnlineDisk(entry);assert.equal(fs.existsSync(file),true);
      const closed=once(reader,'close');await response.arrayBuffer();await closed;
      assert.equal(entry.disk.readers,0);assert.equal(fs.existsSync(directory),false,'close must retry cleanup after ownership ends');
      assert.equal(session.requests.size,0);
    } finally {
      if(reader&&!reader.closed){const closed=once(reader,'close');reader.destroy();await closed;}
      fs.createReadStream=originalRead;fs.rmSync=originalRemove;h.context.clearOnlineCache();fs.rmSync(h.root,{recursive:true,force:true});
    }
  });
  for(const fallback of [false,true]) await check(fallback?'quit waits for protocol HLS fallback cleanup':'quit waits for released online preparation cleanup',async()=>{
    const h=load(), app=h.run('app'); let quits=0,finish,file,pending;
    app.quit=()=>quits++;
    h.context.prepareHlsFile=async(_info,output,{signal})=>{
      file=output;fs.writeFileSync(output,Buffer.alloc(200000));
      await new Promise(resolve=>finish=resolve);
      if(signal.aborted)throw new Error('cancelled fixture');
    };
    try{
      if(fallback){
        h.native.fetchPlayUrlSingle=async()=>({url:'https://fixture.example/bad.mp4',source:'custom',format:'mp4',vid:h.vid,
          candidates:[{url:'https://fixture.example/good.m3u8',source:'custom',format:'hls',vid:h.vid}]});
        h.context.requestMedia=async()=>{throw Object.assign(new Error('bad MP4 candidate'),{mediaRetryable:true});};
        h.context.registerStreamProtocol();
        const prepared=await h.handlers['prepare-online-play']({}, {vid:h.vid,seriesId:h.sid,requestId:'closing'});
        assert.equal(prepared.success,true,prepared.error);
        pending=h.protocols['hongguo-stream'](new Request(prepared.url));
      }else pending=h.handlers['prepare-online-play']({}, {vid:h.vid,seriesId:h.sid,requestId:'closing'});
      await waitFor(()=>!!finish);
      await h.handlers['release-online-play']({}, {requestId:'closing'});
      assert.equal(h.run('onlinePreparing.size'),0,'released job must be absent from preparation lookup');
      assert.ok(fs.existsSync(file),'cleanup is deliberately still pending');
      let prevented=false;app.emit('before-quit',{preventDefault(){prevented=true;}});
      assert.equal(prevented,true,'quit must wait for cleanup even after lookup removal');
      assert.equal(quits,0);
      finish();await pending;await flush();
      assert.equal(fs.existsSync(path.dirname(file)),false,'cleanup must finish before quitting');
      assert.equal(quits,1);
    }finally{
      finish?.();if(pending)await pending;await flush();
      h.context.clearOnlineCache();fs.rmSync(h.root,{recursive:true,force:true});
    }
  });
  await check('quit waits for the actual disk reader close before removing its cache',async()=>{
    const h=load(),app=h.run('app'),originalRead=fs.createReadStream;let reader,finishClose,quits=0;
    app.quit=()=>quits++;
    try{
      const directory=path.join(h.root,'closing-disk');fs.mkdirSync(directory);
      const file=path.join(directory,'video.mp4');fs.writeFileSync(file,Buffer.alloc(4*1024*1024));
      const entry={filePath:file,size:fs.statSync(file).size,disk:{directory,readers:0}};
      const session={vid:h.vid,entry,requests:new Set()};
      h.context.readerSession=session;h.context.readerEntry=entry;
      h.run("onlineSessions.set('reader',readerSession);onlineCache.set('reader',readerEntry)");
      fs.createReadStream=(...args)=>{
        reader=originalRead(...args);const destroy=reader._destroy;
        reader._destroy=(error,callback)=>{finishClose=()=>destroy.call(reader,error,callback);};
        return reader;
      };
      h.context.diskMediaResponse(new Request('https://fixture.example/video'),entry,session);
      h.context.clearOnlineCache();
      assert.equal(entry.disk.readers,1);assert.ok(fs.existsSync(file));
      let prevented=false;app.emit('before-quit',{preventDefault(){prevented=true;}});
      assert.equal(prevented,true,'quit must wait for a released reader that has not closed');
      assert.equal(quits,0);
      await waitFor(()=>!!finishClose);const closed=once(reader,'close');finishClose();await closed;await flush();
      assert.equal(fs.existsSync(directory),false);assert.equal(quits,1);
    }finally{
      if(reader&&!reader.closed){reader.destroy();await waitFor(()=>!!finishClose);const closed=once(reader,'close');finishClose();await closed;}
      fs.createReadStream=originalRead;await flush();h.context.clearOnlineCache();fs.rmSync(h.root,{recursive:true,force:true});
    }
  });
  assert.equal(failures,0,`${failures} disk lifecycle regressions`);
})().catch(error=>{console.error(error.message);process.exitCode=1;});
