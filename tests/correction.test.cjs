const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const clone = v => JSON.parse(JSON.stringify(v));
const code = fs.readFileSync(path.join(__dirname, '../deploy/Code.gs'),'utf8');
function moduleSource(name) {
  const start=code.indexOf('// ===== '+name+' =====');
  assert.ok(start>=0,name);
  const end=code.indexOf('// ===== ',start+10);
  return code.slice(start,end<0?undefined:end);
}
const director={id:'jl',name:'la direction',role:'DIRECTOR',active:true,monitorId:''};
const monitor={id:'one',name:'Camille',role:'MONITOR',active:true,monitorId:'M1'};
const line=(extra={})=>({id:'line1',date:'2026-10-06',start:'09:00',end:'11:00',breakMinutes:0,type:'NORMAL',activity:'Natation',...extra});
function harness(options={}) {
  const tables={};
  ['USERS','TIMESHEETS','RECOVERIES','DOCUMENTS','OUTBOX','AUDIT','HISTORY','IDENTITY'].forEach((name,i)=>tables[name]={id:i+1,maxRows:1000,rows:[['ID','JSON']]});
  const state={today:'2026-11-25',closures:[],expected:[line()],failWrite:false,writes:0};
  const c={console,JSON,Date,Math,Set,Map,Array,Object,String,Number,Boolean,Error,
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>k==='PORTAL_BOOK_ID'?'local-test':''})},
    Utilities:{getUuid:()=>require('node:crypto').randomUUID(),formatDate:()=>state.today},
    ScriptApp:{getOAuthToken:()=> 'TEST_ONLY'},
    UrlFetchApp:{fetch:(url,request)=>{
      if(request.method==='get'){
        let result;
        if(url.includes('/values/')){
          const name=/^'([A-Z]+)'!A:B$/.exec(decodeURIComponent(url.split('/values/')[1].split('?')[0]))[1];
          result={values:clone(tables[name].rows)};
        }else result={sheets:Object.entries(tables).map(([title,t])=>({properties:{sheetId:t.id,title,gridProperties:{rowCount:t.maxRows}}}))};
        return {getResponseCode:()=>200,getContentText:()=>JSON.stringify(result)};
      }
      state.writes++;
      if(state.failWrite)return {getResponseCode:()=>503};
      const pending=clone(tables);
      for(const op of JSON.parse(request.payload).requests){
        if(op.appendDimension){Object.values(pending).find(t=>t.id===op.appendDimension.sheetId).maxRows+=op.appendDimension.length;continue;}
        const update=op.updateCells,t=Object.values(pending).find(t=>t.id===update.range.sheetId);
        t.rows[update.range.startRowIndex]=update.rows[0].values.map(v=>v.userEnteredValue.stringValue);
      }
      for(const name of Object.keys(tables))tables[name]=pending[name];
      return {getResponseCode:()=>200};
    }},
  };
  vm.createContext(c);
  for(const name of ['Storage.gs','Domain.gs','Timesheets.gs','DirectorCorrection.gs'])vm.runInContext(moduleSource(name),c);
  Object.assign(c,{
    pNow_:()=> '2026-11-25T20:00:00Z',pToday_:()=>state.today,
    pPeople_:()=>[{id:'M1',name:'Camille',active:true,sourceMode:'POOL'},{id:'M2',name:'Alex',active:true,sourceMode:'POOL'}],
    pSourceMode_:()=> 'POOL',pExpected_:()=>clone(state.expected),
    pSourceTrue_:v=>v===true||v===1||String(v).toUpperCase()==='TRUE',
    pSourceRows_:(key,name,columns)=>{assert.equal(key,'ADMIN_BOOK_ID');assert.equal(name,'CLOTURES');assert.deepEqual(Array.from(columns),['MoniteurID','Mois','Active']);return clone(state.closures)},
    pFinanceSource_:()=>({rate:20,contributionsConfirmed:true,deductionPct:0,chargePct:0,paidCents:0,adjustmentsMinutes:0}),
    pQueueMail_:()=>{throw Error('Aucun email attendu pendant une correction')},
  });
  const before={id:'M1__2026-10',month:'2026-10',monitorId:'M1',status:'SUBMITTED',revision:2,lines:[line()],sourceMode:'POOL',expectedSnapshot:[line()],declarationNote:'Texte initial du moniteur',submittedAt:'2026-10-29T12:00:00Z',submittedBy:'one',firstSubmittedAt:'2026-10-29T12:00:00Z',submissionCount:1,createdBy:'one',updatedBy:'one',...options.sheet};
  tables.TIMESHEETS.rows.push([before.id,JSON.stringify(before)]);
  const read=name=>tables[name].rows.slice(1).filter(r=>r[0]).map(r=>JSON.parse(r[1]));
  const correct=(extra={},actor=director)=>c.pReview_(actor,{decision:'CORRECT',sheetId:before.id,revision:before.revision,lines:[line({end:'12:00'})],comment:'Fin réelle du cours vérifiée.',...extra});
  return {c,tables,state,before,read,correct};
}
test('les fichiers déployables compilent et le serveur charge le complément d’interface',()=>{
  assert.doesNotThrow(()=>new vm.Script(code));
  const ui=fs.readFileSync(path.join(__dirname,'../apps-script/DirectorCorrectionUi.html'),'utf8');
  for(const block of ui.matchAll(/<script>([\s\S]*?)<\/script>/g))assert.doesNotThrow(()=>new vm.Script(block[1]));
  const doGet=code.match(/^function doGet\(\).*$/m)[0];
  const output=s=>({getContent:()=>s,setTitle(){return this},addMetaTag(){return this}});
  const c={HtmlService:{createHtmlOutputFromFile:n=>output(n==='Index'?'<body>INDEX</body>':ui),createHtmlOutput:output}};
  vm.runInNewContext(doGet,c);const result=c.doGet().getContent();
  assert.ok(result.includes(ui+'</body>'));assert.ok(result.startsWith('<body>INDEX'));
});
test('la direction corrige une fiche après le délai du moniteur, sans la valider ni envoyer de mail',()=>{
  const h=harness();assert.equal(h.c.pMonth_(monitor,{month:'2026-10'}).canEdit,false);
  const result=h.correct(),s=result.sheet;
  assert.equal(s.lines[0].end,'12:00');assert.equal(s.status,'SUBMITTED');assert.equal(s.revision,3);
  assert.equal(result.summary.workedMinutes,180);assert.equal(result.finance.dueCents,null);
  assert.equal(s.validatedAt,'');assert.equal(s.validatedBy,'');assert.equal(s.updatedBy,'jl');
  assert.equal(h.read('OUTBOX').length,0);assert.equal(result.canApprove,true);
});
test('l’auteur de la correction et la version précédente sont enregistrés dans le même batch',()=>{
  const h=harness();h.correct();assert.equal(h.state.writes,1);
  assert.deepEqual(h.read('HISTORY')[0].previous,h.before);
  assert.equal(h.read('HISTORY')[0].actorId,'jl');assert.equal(h.read('AUDIT')[0].actorId,'jl');
  assert.equal(h.read('AUDIT')[0].action,'CORRIGER_FICHE_DIRECTION');
  const s=h.read('TIMESHEETS')[0];assert.equal(s.directorCorrection.name,'la direction');assert.equal(s.directorCorrectionCount,1);
  for(const key of ['submittedAt','submittedBy','submissionCount','firstSubmittedAt','createdBy','monitorId','declarationNote'])assert.equal(s[key],h.before[key],key);
});
test('un brouillon ou une fiche à corriger peut être repris par la direction',()=>{
  for(const status of ['DRAFT','RETURNED']){
    const h=harness({sheet:{status,submittedAt:'',firstSubmittedAt:'',submittedBy:'',submissionCount:0}});
    const s=h.correct().sheet;assert.equal(s.status,'SUBMITTED');assert.equal(s.submittedAt,'');assert.equal(s.submissionCount,0);
    assert.equal(s.directorCorrection.previousStatus,status);
  }
});
test('aucun autre rôle et aucun compte inactif ne peut corriger à la place du moniteur',()=>{
  for(const role of ['MONITOR','MANAGER','SECRETARY','TECHNICAL']){
    const h=harness();assert.throws(()=>h.correct({}, {...director,role}),/réservée/);assert.equal(h.state.writes,0);
  }
  const h=harness();assert.throws(()=>h.correct({}, {...director,active:false}),/inactif/);assert.equal(h.state.writes,0);
  assert.throws(()=>h.c.pSaveDraft_(director,{month:'2026-10',monitorId:'M1',revision:2,lines:[]}),/non autorisé/);
});
test('une révision obsolète n’écrase pas une modification concurrente',()=>{
  const h=harness();h.correct();assert.throws(()=>h.correct(),/changé/);assert.equal(h.state.writes,1);assert.equal(h.read('HISTORY').length,1);
});
test('une fiche validée exige une réouverture motivée avant correction',()=>{
  const h=harness({sheet:{status:'APPROVED',validatedAt:'2026-11-02',validatedBy:'jl'}});
  assert.throws(()=>h.correct(),/Rouvrez/);assert.equal(h.state.writes,0);
  const reopened=h.c.pReview_(director,{sheetId:h.before.id,revision:2,decision:'REOPEN',comment:'Erreur signalée'});
  assert.equal(h.correct({revision:reopened.sheet.revision}).sheet.validatedAt,'');
});
test('la clôture administrative doit être rouverte même si la fiche est modifiable',()=>{
  for(const Active of [true,1,'TRUE']){
    const h=harness();h.state.closures=[{MoniteurID:'M1',Mois:'2026-10',Active}];
    assert.throws(()=>h.correct(),/clôturé/);assert.equal(h.state.writes,0);
  }
  const h=harness();h.state.closures=[{MoniteurID:'M1',Mois:'2026-10',Active:false},{MoniteurID:'M2',Mois:'2026-10',Active:true}];assert.equal(h.correct().sheet.revision,3);
});
test('motif obligatoire, changement réel obligatoire et lectures de clôture fiables',()=>{
  const h=harness();assert.throws(()=>h.correct({comment:'  '}),/motif/);
  assert.throws(()=>h.correct({lines:[line()]}),/Aucune modification/);
  h.c.pSourceRows_=()=>{throw Error('Stockage indisponible')};assert.throws(()=>h.correct(),/Stockage/);assert.equal(h.state.writes,0);
});
test('les contrôles habituels empêchent dates hors mois, chevauchements et remplacement invalide',()=>{
  for(const lines of [[line({date:'2026-11-06'})],[line({end:'08:00'})],[line(),line({id:'two',start:'10:00',end:'12:00'})],[line({type:'REMPLACEMENT',replacedMonitorId:'M1',sourceRef:'Séance'})],[line({type:'RECUPERATION',sourceRef:''})]]){
    const h=harness();assert.throws(()=>h.correct({lines}));assert.equal(h.state.writes,0);
  }
});
test('la correction d’un mois en cours conserve la validation bloquée avant la fin du mois',()=>{
  const h=harness();h.state.today='2026-10-25';const result=h.correct();assert.equal(result.canApprove,false);
  assert.throws(()=>h.c.pReview_(director,{sheetId:h.before.id,revision:3,decision:'APPROVE',comment:'Contrôlé'}),/après la fin du mois/);
  h.state.today='2026-11-01';assert.equal(h.c.pReview_(director,{sheetId:h.before.id,revision:3,decision:'APPROVE',comment:'Écart contrôlé'}).sheet.status,'APPROVED');
});
test('un mois futur est interdit, les crédits restent à contrôler lors de la validation',()=>{
  const future=harness();future.state.today='2026-09-25';assert.throws(()=>future.correct(),/mois futur/);assert.equal(future.state.writes,0);
  const h=harness();const r=h.correct({lines:[line({type:'RECUPERATION',sourceRef:'Cours précédent'})]});
  assert.throws(()=>h.c.pReview_(director,{sheetId:h.before.id,revision:r.sheet.revision,decision:'APPROVE',comment:'Contrôle'}),/Associez/);
});
test('un échec d’enregistrement ne modifie ni la fiche ni l’historique',()=>{
  const h=harness();h.state.failWrite=true;assert.throws(()=>h.correct(),/Enregistrement impossible/);
  assert.deepEqual(h.read('TIMESHEETS')[0],h.before);assert.equal(h.read('HISTORY').length,0);assert.equal(h.read('AUDIT').length,0);
});
test('le moniteur peut encore demander sa propre correction sans obtenir le droit de corriger autrui',()=>{
  const h=harness();h.correct();h.state.today='2026-11-05';const v=h.c.pMonth_(monitor,{month:'2026-10'});
  assert.equal(v.canEdit,true);const updated=h.c.pSaveDraft_(monitor,{month:'2026-10',revision:3,lines:[line({end:'13:00'})],declarationNote:'Correction personnelle'});
  assert.equal(updated.sheet.status,'DRAFT');assert.equal(h.read('HISTORY').at(-1).actorId,'one');
});
