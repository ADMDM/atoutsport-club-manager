const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.join(__dirname, '../apps-script');
const copy = x => JSON.parse(JSON.stringify(x));

// Real source adapter, real frontend mapper and real domain validation.
// Only Google Sheets I/O and UUID generation are replaced by in-memory fixtures.
function harness(extra={}) {
 const matrices={
  MONITEURS:[['MoniteurID','Nom','Prenom','Actif','Fonction'],['MON001','Alpha','Alice',true,'MONITEUR'],['MON002','Beta','Bob',true,'MONITEUR']],
  HORAIRES:[['HoraireID','MoniteurID','JourSemaine','HeureDebut','HeureFin','Actif','Activite'],['h-1','MON001','Lundi',9/24,12/24,true,'Natation']],
  PRESENCES:[['PresenceID','MoniteurID','Date','HeureDebut','HeureFin','Present']],
  EXCEPTIONS:[['ExceptionID','MoniteurID','Date','Type','HeureDebut','HeureFin','RemplacantID','Active']],
  ...extra
 };
 const context=vm.createContext({console,crypto:{randomUUID:()=>crypto.randomUUID()},pId_:()=>crypto.randomUUID(),
  PropertiesService:{getScriptProperties:()=>({getProperty:key=>key==='TV_BOOK_ID'?'tv-source':null})},
  SpreadsheetApp:{openById:id=>{assert.equal(id,'tv-source');return {getSheetByName:name=>{
   const rows=matrices[name];assert.ok(rows,'fixture source table '+name);
   return {getLastRow:()=>rows.length,getLastColumn:()=>rows[0].length,getRange:(row,col,height,width)=>({getValues:()=>rows.slice(row-1,row-1+height).map(r=>r.slice(col-1,col-1+width))})};
  }};}}
 });
 vm.runInContext(fs.readFileSync(path.join(root,'Sources.gs'),'utf8'),context);
 vm.runInContext(fs.readFileSync(path.join(root,'Domain.gs'),'utf8'),context);
 const html=fs.readFileSync(path.join(root,'Index.html'),'utf8');
 const mapper=html.match(/^function planningLines\([^\n]+$/m);
 assert.ok(mapper,'Index.html exposes the actual planningLines mapper for this cross-layer regression');
 vm.runInContext(mapper[0],context);
 return context;
}

test('le planning Sheets réel peut être repris par l’UI puis accepté comme brouillon sans perdre heures et activité',()=>{
 const c=harness(),expected=c.pExpected_('2026-11','MON001');
 assert.equal(expected.length,5);
 assert.ok(expected.every(x=>x.id.includes(':')),'source IDs are provenance IDs, not draft UUIDs');
 const browserLines=c.planningLines(expected);
 const normalized=c.pNormalizeLines_(browserLines,'2026-11','MON001',c.pTeam_());
 assert.equal(normalized.length,5);
 assert.ok(normalized.every(l=>/^[a-f0-9-]{36}$/.test(l.id)&&l.type==='NORMAL'&&l.activity==='Natation'));
 assert.equal(new Set(normalized.map(l=>l.id)).size,5);
 const summary=c.pSummarize_(normalized,expected,[],[],'sheet_A','MON001');
 assert.equal(summary.workedMinutes,900);assert.equal(summary.expectedMinutes,900);assert.equal(summary.differenceMinutes,0);
});

test('un remplacement provenant du planning conserve le remplacé et la séance après le passage par le formulaire',()=>{
 const c=harness({EXCEPTIONS:[['ExceptionID','MoniteurID','Date','Type','HeureDebut','HeureFin','RemplacantID','Active'],['r-1','MON001','2026-11-02','REMPLACEMENT','09:00','12:00','MON002',true]]});
 const expected=c.pExpected_('2026-11','MON002');assert.equal(expected.length,1);assert.equal(expected[0].replacedMonitorId,'MON001');
 const normalized=c.pNormalizeLines_(c.planningLines(expected),'2026-11','MON002',c.pTeam_());
 assert.equal(normalized[0].type,'REMPLACEMENT');assert.equal(normalized[0].replacedMonitorId,'MON001');assert.ok(normalized[0].sourceRef);
 assert.equal(c.pLineMinutes_(normalized[0]),180);
 assert.equal(c.pExpected_('2026-11','MON001').filter(l=>l.date==='2026-11-02').length,0);
});

test('une absence partielle ne réapparaît pas comme travail payé après le préremplissage',()=>{
 const c=harness({EXCEPTIONS:[['ExceptionID','MoniteurID','Date','Type','HeureDebut','HeureFin','RemplacantID','Active'],['a-1','MON001','2026-11-02','ABSENCE','10:00','11:00','',true]]});
 const expected=c.pExpected_('2026-11','MON001'),normalized=c.pNormalizeLines_(c.planningLines(expected),'2026-11','MON001',c.pTeam_());
 const summary=c.pSummarize_(normalized,expected,[],[],'sheet_A','MON001');
 assert.equal(summary.workedMinutes,840);assert.equal(summary.payableMinutes,840);assert.equal(summary.differenceMinutes,0);
 assert.deepEqual(copy(normalized.filter(l=>l.date==='2026-11-02').map(l=>[l.start,l.end])),[['09:00','10:00'],['11:00','12:00']]);
});
