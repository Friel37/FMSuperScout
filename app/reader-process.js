'use strict';
const fs = require('fs');
const path = require('path');
const {spawn, execFile} = require('child_process');
function createReader(executable, dataDir, runner = {spawn, execFile}) {
  let child = null;
  function error(message) {
    fs.mkdirSync(dataDir, {recursive:true});
    const file = path.join(dataDir, 'status.json');
    fs.writeFileSync(file + '.server.tmp', JSON.stringify({state:'error',error:message,at:new Date().toISOString(),players:0,staff:0}));
    fs.renameSync(file + '.server.tmp', file);
  }
  function probe(cb) {
    if (!fs.existsSync(executable)) return cb({known:true,readerInstalled:false,running:false,error:'Reader missing. Run tools/setup-local.ps1.'});
    runner.execFile(executable, ['probe'], {windowsHide:true,timeout:10000}, (err, out) => {
      try { if(err) throw err; cb({...JSON.parse(out),known:true,readerInstalled:true}); }
      catch(e) {cb({known:true,readerInstalled:true,running:false,error:e.message});}
    });
  }
  function refresh() {
    if(child) return {code:409,ok:false,error:'A read is already running.'};
    if(!fs.existsSync(executable)) {error('Reader missing. Run tools/setup-local.ps1.');return {code:503,ok:false,error:'Reader missing. Run tools/setup-local.ps1.'};}
    fs.mkdirSync(dataDir,{recursive:true});
    const statusFile = path.join(dataDir,'status.json');
    fs.writeFileSync(statusFile+'.server.tmp',JSON.stringify({state:'scanning',players:0,staff:0,at:new Date().toISOString(),progress:0}));
    fs.renameSync(statusFile+'.server.tmp',statusFile);
    const log = fs.openSync(path.join(dataDir,'reader.log'),'w');
    try { child=runner.spawn(executable,['dump','--data-dir',dataDir],{windowsHide:true,stdio:['ignore',log,log]}); }
    catch(e) {error(e.message);return {code:500,ok:false,error:e.message};}
    finally {fs.closeSync(log);}
    child.once('error', e=>{child=null;error(e.message);});
    child.once('exit', code=>{child=null;if(code!==0){
      let state;try{state=JSON.parse(fs.readFileSync(path.join(dataDir,'status.json'),'utf8'));}catch{}
      if(state?.state!=='error')error('Reader stopped before completing. Load your save and retry.');
    }});
    return {code:202,ok:true};
  }
  return {probe,refresh};
}
module.exports = {createReader};
