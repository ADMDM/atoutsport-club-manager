const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../apps-script/Storage.gs'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
function harness(options={}) {
 const tables={},requests=[],reads=[];
 for(const [i,name] of ['USERS','TIMESHEETS','RECOVERIES','DOCUMENTS','OUTBOX','AUDIT','HISTORY'].entries())tables[name]={id:i+1,maxRows:options.maxRows||1000,rows:[['ID','JSON'],...(options.rows?.[name]||[])]};
 // Reproduit le cache réellement observé : SpreadsheetApp ne voit jamais les
 // écritures REST réalisées ensuite pendant la même invocation.
 const stale=clone(tables);
 const sheet=name=>({getSheetId:()=>stale[name].id,getLastRow:()=>stale[name].rows.length,getMaxRows:()=>stale[name].maxRows,
  getRange:(row,col,n=1,width=1)=>({getValues:()=>Array.from({length:n},(_,i)=>Array.from({length:width},(_,j)=>stale[name].rows[row+i-1]?.[col+j-1]??''))})});
 const book={getId:()=> 'portal-only',getSheetByName:name=>tables[name]?sheet(name):null};
 let locks=0,releases=0;
 const ctx=vm.createContext({console,
  PropertiesService:{getScriptProperties:()=>({getProperty:name=>name==='PORTAL_BOOK_ID'?'portal-only':null})},
  SpreadsheetApp:{openById:id=>{assert.equal(id,'portal-only');return book;}},
  Utilities:{getUuid:()=>crypto.randomUUID(),base64EncodeWebSafe:x=>Buffer.from(x).toString('base64url'),computeDigest:(_alg,text)=>crypto.createHash('sha256').update(text).digest(),DigestAlgorithm:{SHA_256:'sha256'},formatDate:()=> '2026-11-11'},
  LockService:{getScriptLock:()=>({tryLock:()=>{locks++;return !options.lockFailure;},releaseLock:()=>{releases++;}})},
  ScriptApp:{getOAuthToken:()=> 'server-token'},
  UrlFetchApp:{fetch:(url,request)=>{
   if(request.method==='get'){
    reads.push({url,request});
    if(options.readFailure)return {getResponseCode:()=>503};
    const parsed=new URL(url);let result;
    assert.equal(request.headers.Authorization,'Bearer server-token');
    if(parsed.pathname==='/v4/spreadsheets/portal-only'){
     assert.equal(parsed.searchParams.get('fields'),'sheets(properties(sheetId,title,gridProperties(rowCount)))');
     result={sheets:Object.entries(tables).map(([title,t])=>({properties:{sheetId:t.id,title,gridProperties:{rowCount:t.maxRows}}}))};
    }else{
     assert.equal(parsed.searchParams.get('valueRenderOption'),'UNFORMATTED_VALUE');
     assert.equal(parsed.searchParams.get('majorDimension'),'ROWS');
     const range=decodeURIComponent(parsed.pathname.split('/values/')[1]||'');
     const name=/^'([A-Z]+)'!A:B$/.exec(range)?.[1];assert.ok(tables[name]);
     const values=clone(tables[name].rows).map(r=>{while(r.length&&r.at(-1)==='')r.pop();return r;});
     while(values.length&&!values.at(-1).length)values.pop();
     result={values};
    }
    return {getResponseCode:()=>200,getContentText:()=>JSON.stringify(result)};
   }
   requests.push({url,request});const batch=JSON.parse(request.payload);
   assert.equal(url,'https://sheets.googleapis.com/v4/spreadsheets/portal-only:batchUpdate');
   if(options.httpFailure)return {getResponseCode:()=>503};
   const pending=clone(tables);
   for(const operation of batch.requests){
    if(operation.appendDimension){const op=operation.appendDimension;Object.values(pending).find(s=>s.id===op.sheetId).maxRows+=op.length;continue;}
    if(!operation.updateCells)continue;const op=operation.updateCells;
    const table=Object.values(pending).find(s=>s.id===op.range.sheetId);
    assert.ok(op.range.endRowIndex<=table.maxRows,'le batch doit étendre la grille avant écriture');
    table.rows[op.range.startRowIndex]=op.rows[0].values.map(c=>c.userEnteredValue.stringValue);
   }
   for(const [name,table] of Object.entries(pending)){tables[name].rows=table.rows;tables[name].maxRows=table.maxRows;}
   return {getResponseCode:()=>200};
  }}
 });
 vm.runInContext(source,ctx);
 return {ctx,tables,requests,reads,get locks(){return locks;},get releases(){return releases;}};
}
const row=o=>[o.id,JSON.stringify(o)];

test('une transaction enregistre la fiche, la notification et l’audit dans un seul batch',()=>{
 const {ctx,requests,tables}=harness();
 ctx.pCommit_([{table:'TIMESHEETS',record:{id:'sheet_A',revision:1,status:'SUBMITTED'}},{table:'OUTBOX',record:{id:'mail_A',revision:1,status:'PENDING'}}],{id:'alice'},'SUBMIT');
 assert.equal(requests.length,1);
 assert.equal(JSON.parse(tables.TIMESHEETS.rows[1][1]).status,'SUBMITTED');
 assert.equal(JSON.parse(tables.OUTBOX.rows[1][1]).status,'PENDING');
 assert.equal(JSON.parse(tables.AUDIT.rows[1][1]).actorId,'alice');
});
test('un échec de batch ne confirme aucune mutation et laisse la fiche précédente intacte',()=>{
 const old={id:'sheet_A',revision:1,status:'DRAFT'};
 const {ctx,tables}=harness({httpFailure:true,rows:{TIMESHEETS:[row(old)]}});
 assert.throws(()=>ctx.pCommit_([{table:'TIMESHEETS',record:{...old,revision:2,status:'SUBMITTED'}}],{id:'alice'},'SUBMIT'),/Enregistrement impossible/);
 assert.deepEqual(JSON.parse(tables.TIMESHEETS.rows[1][1]),old);
 assert.equal(tables.AUDIT.rows.length,1);
 assert.equal(tables.HISTORY.rows.length,1);
});
test('les corrections conservent chaque version précédente dans la transaction de la fiche',()=>{
 const before={id:'sheet_A',revision:1,status:'RETURNED',lines:[{id:'line1',start:'09:00',end:'10:00'}]};
 const {ctx,tables,requests}=harness({rows:{TIMESHEETS:[row(before)]}});
 const next={...before,revision:2,status:'DRAFT',lines:[{id:'line1',start:'09:00',end:'11:00'}]};
 ctx.pCommit_([{table:'TIMESHEETS',record:next}],{id:'alice'},'SAVE');
 const first=JSON.parse(tables.HISTORY.rows[1][1]);
 assert.deepEqual(first.previous,before);
 assert.equal(first.sheetId,'sheet_A');assert.equal(first.actorId,'alice');assert.equal(first.action,'SAVE');
 const batch=JSON.parse(requests[0].request.payload).requests;
 assert.ok(batch.some(r=>r.updateCells?.range.sheetId===tables.HISTORY.id));
 assert.ok(batch.some(r=>r.updateCells?.range.sheetId===tables.TIMESHEETS.id));
 ctx.pCommit_([{table:'TIMESHEETS',record:{...next,revision:3,status:'SUBMITTED'}}],{id:'alice'},'SUBMIT');
 assert.deepEqual(JSON.parse(tables.HISTORY.rows[1][1]),first);
 assert.deepEqual(JSON.parse(tables.HISTORY.rows[2][1]).previous,next);
});
test('la mise à jour d’un ID utilise sa ligne physique même si une ligne précédente est vide',()=>{
 const first={id:'first',revision:1},last={id:'last',revision:1};
 const {ctx,tables}=harness({rows:{USERS:[row(first),['',''],row(last)]}});
 ctx.pCommit_([{table:'USERS',record:{...last,revision:2}}],{id:'director'},'UPDATE');
 assert.deepEqual(JSON.parse(tables.USERS.rows[1][1]),first);
 assert.deepEqual(tables.USERS.rows[2],['','']);
 assert.deepEqual(JSON.parse(tables.USERS.rows[3][1]),{...last,revision:2});
});
test('les ID physiques dupliqués sont rejetés avant toute mutation',()=>{
 const duplicate={id:'same',revision:1};
 const {ctx,requests}=harness({rows:{USERS:[row(duplicate),row(duplicate)]}});
 assert.throws(()=>ctx.pCommit_([{table:'USERS',record:{...duplicate,revision:2}}],{id:'director'},'UPDATE'),/dupliqu|doubl|unique/i);
 assert.equal(requests.length,0);
});
test('les doublons d’une transaction et les données trop volumineuses sont rejetés',()=>{
 const {ctx,requests}=harness();
 assert.throws(()=>ctx.pCommit_([{table:'USERS',record:{id:'same'}},{table:'USERS',record:{id:'same'}}],{id:'x'},'X'),/dupliquée/);
 assert.throws(()=>ctx.pCommit_([{table:'USERS',record:{id:'big',note:'x'.repeat(45001)}}],{id:'x'},'X'),/volumineuse/);
 assert.equal(requests.length,0);
});
test('le texte ressemblant à une formule reste du texte JSON et jamais une formule Sheets',()=>{
 const {ctx,requests}=harness();
 ctx.pCommit_([{table:'TIMESHEETS',record:{id:'sheet_A',note:'=IMPORTXML("https://invalid.test","//x")'}}],{id:'x'},'SAVE');
 const cells=JSON.parse(requests[0].request.payload).requests.flatMap(r=>r.updateCells?.rows[0].values||[]);
 assert.ok(cells.every(c=>Object.keys(c.userEnteredValue).length===1&&typeof c.userEnteredValue.stringValue==='string'));
});
test('les lectures sont des copies indépendantes et reflètent le batch réussi sans relire SpreadsheetApp',()=>{
 const {ctx}=harness({rows:{USERS:[row({id:'A',revision:1})]}});
 const first=ctx.pRows_('USERS');first[0].revision=99;
 assert.equal(ctx.pGet_('USERS','A').revision,1);
 ctx.pCommit_([{table:'USERS',record:{id:'A',revision:2}}],{id:'x'},'UPDATE');
 assert.equal(ctx.pGet_('USERS','A').revision,2);
});
test('une installation rend immédiatement les quatre comptes malgré le cache SpreadsheetApp obsolète',()=>{
 const {ctx,reads}=harness();
 ctx.pWithLock_(()=>{
  assert.equal(ctx.pRows_('USERS').length,0);
  const changes=['director','manager','secretary','adam'].map(id=>({table:'USERS',record:{id,revision:1}}));
  ctx.pCommit_(changes,{id:'INSTALLER'},'INSTALLER_COMPTES_PREVUS');
  assert.equal(ctx.pRows_('USERS').length,4);
  const after=reads.length;ctx.pRows_('USERS');assert.equal(reads.length,after);
 });
});
test('des commits successifs conservent les quatre invitations et chaque ligne audit sans écrasement',()=>{
 const accounts=['director','manager','secretary','adam'].map(id=>({id,revision:1}));
 const {ctx,tables}=harness({rows:{USERS:accounts.map(row)}});
 ctx.pWithLock_(()=>{
  for(const u of ctx.pRows_('USERS'))ctx.pCommit_([
   {table:'USERS',record:{...u,revision:2,inviteHash:'hash-'+u.id}},
   {table:'OUTBOX',record:{id:'invite:'+u.id,revision:1,status:'PENDING'}}
  ],{id:'INSTALLER'},'PREPARER_INVITATION');
  assert.equal(ctx.pRows_('OUTBOX').length,4);
  assert.equal(ctx.pRows_('AUDIT').length,4);
  assert.ok(ctx.pRows_('USERS').every(u=>u.revision===2));
 });
 assert.equal(tables.OUTBOX.rows.length,5);assert.equal(tables.AUDIT.rows.length,5);
 assert.deepEqual(tables.OUTBOX.rows.slice(1).map(r=>r[0]),accounts.map(u=>'invite:'+u.id));
});
test('deux verrous successifs dans la même invocation relisent les écritures REST et celles d’un autre traitement',()=>{
 const {ctx,tables,reads}=harness();
 ctx.pWithLock_(()=>ctx.pCommit_([{table:'USERS',record:{id:'A',revision:1}}],{id:'x'},'CREATE'));
 // Une autre opération terminée pendant l'intervalle doit aussi être visible.
 tables.USERS.rows.push(row({id:'B',revision:1}));
 const before=reads.length;
 ctx.pWithLock_(()=>{
  assert.deepEqual(clone(ctx.pRows_('USERS')).map(u=>u.id),['A','B']);
  ctx.pCommit_([{table:'USERS',record:{id:'C',revision:1}}],{id:'x'},'CREATE');
 });
 assert.ok(reads.length>before);
 assert.deepEqual(tables.USERS.rows.slice(1).map(r=>r[0]),['A','B','C']);
 assert.equal(tables.AUDIT.rows.length,3);
});
test('les transitions d’envoi répétées ne dupliquent ni le mail ni l’audit et relisent le dernier état',()=>{
 const mail={id:'mail_A',status:'PENDING',revision:1};
 const {ctx,tables}=harness({rows:{OUTBOX:[row(mail)]}});
 ctx.pWithLock_(()=>{
  for(const status of ['SENDING','SENT']){
   const previous=ctx.pGet_('OUTBOX',mail.id);
   ctx.pCommit_([{table:'OUTBOX',record:{...previous,status,revision:previous.revision+1}}],{id:'MAIL_SERVICE'},status);
  }
  assert.equal(ctx.pGet_('OUTBOX',mail.id).revision,3);
  assert.equal(ctx.pGet_('OUTBOX',mail.id).status,'SENT');
 });
 assert.equal(tables.OUTBOX.rows.length,2);assert.equal(tables.AUDIT.rows.length,3);
});
test('un batch refusé ne publie aucune révision ni position nouvelle dans le cache',()=>{
 const {ctx}=harness({httpFailure:true,rows:{USERS:[row({id:'A',revision:1})]}});
 assert.throws(()=>ctx.pCommit_([{table:'USERS',record:{id:'A',revision:2}},{table:'USERS',record:{id:'B',revision:1}}],{id:'x'},'UPDATE'),/Enregistrement impossible/);
 assert.deepEqual(clone(ctx.pRows_('USERS')),[{id:'A',revision:1}]);
 assert.equal(ctx.pRows_('AUDIT').length,0);
});
test('une lecture REST en échec arrête avant toute écriture',()=>{
 const {ctx,requests}=harness({readFailure:true});
 assert.throws(()=>ctx.pCommit_([{table:'USERS',record:{id:'A'}}],{id:'x'},'CREATE'),/Lecture du stockage impossible/);
 assert.equal(requests.length,0);
});
test('la capacité de grille reste cohérente après extension et commits successifs',()=>{
 const {ctx,tables,requests}=harness({maxRows:2});
 ctx.pWithLock_(()=>{
  for(const id of ['A','B','C'])ctx.pCommit_([{table:'USERS',record:{id,revision:1}}],{id:'x'},'CREATE');
 });
 assert.deepEqual(tables.USERS.rows.slice(1).map(r=>r[0]),['A','B','C']);
 const extensions=requests.flatMap(r=>JSON.parse(r.request.payload).requests).filter(r=>r.appendDimension);
 assert.equal(extensions.filter(r=>r.appendDimension.sheetId===tables.USERS.id).length,1);
 assert.equal(extensions.filter(r=>r.appendDimension.sheetId===tables.AUDIT.id).length,1);
});
test('le verrou est libéré même après erreur et un verrou indisponible ne lance pas la mutation',()=>{
 const h=harness();assert.throws(()=>h.ctx.pWithLock_(()=>{throw Error('failed');}),/failed/);
 assert.equal(h.locks,1);assert.equal(h.releases,1);
 const blocked=harness({lockFailure:true});let called=false;
 assert.throws(()=>blocked.ctx.pWithLock_(()=>{called=true;}),/en cours/);assert.equal(called,false);
});
test('le hash d’une structure change lorsque ses horaires changent',()=>{
 const {ctx}=harness();
 assert.notEqual(ctx.pHash_([{start:'09:00',end:'10:00'}]),ctx.pHash_([{start:'09:00',end:'11:00'}]));
});
