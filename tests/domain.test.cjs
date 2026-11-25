const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.join(__dirname,'..','apps-script');
function domain(){const c={pId_:()=> 'new-line'};vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(root,'Domain.gs'),'utf8'),c);return c;}
const line=(extra={})=>({id:'one',date:'2026-10-06',start:'09:00',end:'11:00',breakMinutes:0,type:'NORMAL',activity:'Natation',...extra});
const team=[{id:'M1'},{id:'M2'}];
test('normalisation calcule les minutes, élimine les champs financiers du navigateur',()=>{
  const c=domain(),rows=c.pNormalizeLines_([line({end:'12:30',breakMinutes:15,paidBefore:true,rate:900})],'2026-10','M1',team);
  assert.equal(c.pLineMinutes_(rows[0]),195);assert.equal(rows[0].paidBefore,undefined);assert.equal(rows[0].rate,undefined);
});
test('dates, types, bornes, pauses, chevauchements et doublons sont contrôlés',()=>{
  const c=domain(),bad=[line({date:'2026-02-30'}),line({date:'2026-09-30'}),line({type:'PAYME'}),line({end:'08:00'}),line({breakMinutes:120}),line({type:'ABSENCE',breakMinutes:1})];
  for(const row of bad)assert.throws(()=>c.pNormalizeLines_([row],'2026-10','M1',team));
  assert.throws(()=>c.pNormalizeLines_([line(),line({id:'two',start:'10:00',type:'ABSENCE'})],'2026-10','M1',team),/chevauchent/);
  assert.throws(()=>c.pNormalizeLines_([line(),line({date:'2026-10-07'})],'2026-10','M1',team),/dupliqué/);
  assert.throws(()=>c.pNormalizeLines_(Array(121).fill(line()),'2026-10','M1',team),/120/);
});
test('remplacement exige une personne distincte et une séance identifiable',()=>{
  const c=domain();assert.throws(()=>c.pNormalizeLines_([line({type:'REMPLACEMENT',replacedMonitorId:'M1',sourceRef:'séance'})],'2026-10','M1',team));
  assert.throws(()=>c.pNormalizeLines_([line({type:'REMPLACEMENT',replacedMonitorId:'M2'})],'2026-10','M1',team));
  assert.equal(c.pNormalizeLines_([line({type:'REMPLACEMENT',replacedMonitorId:'M2',sourceRef:'séance-3'})],'2026-10','M1',team)[0].replacedMonitorId,'M2');
});
test('absence non payée : retirer une plage absente une seule fois',()=>{
  const c=domain(),rows=c.pNormalizeLines_([line({end:'10:00'}),line({id:'abs',start:'10:00',type:'ABSENCE'})],'2026-10','M1',team);
  const s=c.pSummarize_(rows,[line()],[],[],'sheet','M1');
  assert.equal(s.workedMinutes,60);assert.equal(s.absenceMinutes,60);assert.equal(s.expectedMinutes,120);assert.equal(s.payableMinutes,60);assert.equal(s.differenceMinutes,-60);
});
test('une récupération déjà payée reste travaillée mais ne génère aucun double paiement',()=>{
  const c=domain(),r=line({type:'RECUPERATION',sourceRef:'octobre',recoveryId:'credit'}),credit={id:'credit',monitorId:'M1',date:'2026-09-01',minutes:120,paidBefore:true};
  const s=c.pSummarize_([r],[],[credit],[],'sheet','M1');
  assert.equal(s.workedMinutes,120);assert.equal(s.alreadyPaidMinutes,120);assert.equal(s.payableMinutes,0);assert.equal(s.unresolvedRecoveries,0);
  const f=c.pCalculateFinance_(s,{rate:20,contributionsConfirmed:true,deductionPct:0,chargePct:0,paidCents:0});assert.equal(f.grossCents,0);
});
test('rattrapage de cours utilise aussi le crédit et son état de paiement',()=>{
  const c=domain(),r=line({type:'RATTRAPAGE_COURS',sourceRef:'cours-1',recoveryId:'credit'}),credit={id:'credit',monitorId:'M1',date:'2026-09-01',minutes:120,paidBefore:false};
  const rows=c.pNormalizeLines_([r],'2026-10','M1',team);assert.equal(rows[0].recoveryId,'credit');
  const s=c.pSummarize_(rows,[],[credit],[],'sheet','M1');assert.equal(s.payableMinutes,120);
  credit.paidBefore=true;assert.equal(c.pSummarize_(rows,[],[credit],[],'sheet','M1').payableMinutes,0);
});
test('crédits inconnus, mauvais moniteur, origine future ou dépassement bloquent un montant fiable',()=>{
  const c=domain(),r=line({type:'RECUPERATION',sourceRef:'source',recoveryId:'credit'}),credit={id:'credit',monitorId:'M1',date:'2026-09-01',minutes:120,paidBefore:true};
  for(const credits of [[],[{...credit,monitorId:'M2'}],[{...credit,date:'2026-10-07'}],[{...credit,minutes:119}]]){
    const s=c.pSummarize_([r],[],credits,[],'sheet','M1');assert.ok(s.unresolvedRecoveries>0);
    assert.equal(c.pCalculateFinance_(s,{rate:20,paidCents:0}).grossCents,null);
  }
});
test('la consommation des crédits compte les autres fiches validées, jamais deux fois la fiche courante',()=>{
  const c=domain(),r=line({type:'RECUPERATION',sourceRef:'source',recoveryId:'credit'}),credit={id:'credit',monitorId:'M1',date:'2026-09-01',minutes:120,paidBefore:true};
  const all=[{id:'sheet',status:'APPROVED',lines:[r]}];assert.equal(c.pSummarize_([r],[],[credit],all,'sheet','M1').unresolvedRecoveries,0);
  all.push({id:'other',status:'APPROVED',lines:[r]});assert.ok(c.pSummarize_([r],[],[credit],all,'sheet','M1').unresolvedRecoveries>0);
});
test('comparaison par date révèle des écarts qui se compensent au total du mois',()=>{
  const c=domain(),s=c.pSummarize_([line({date:'2026-10-07'})],[line()],[],[],'sheet','M1');
  assert.equal(s.differenceMinutes,0);assert.equal(s.byDate.length,2);assert.ok(s.byDate.every(d=>d.differenceMinutes!==0));
});
test('calcul centimes et corrections v2 non additionnées à la déclaration',()=>{
  const c=domain(),summary={payableMinutes:195,unresolvedRecoveries:0};
  const f=c.pCalculateFinance_(summary,{rate:17.5,deductionPct:10,chargePct:5.42,contributionsConfirmed:true,paidCents:1000,adjustmentsMinutes:60});
  assert.equal(f.grossCents,5688);assert.equal(f.dueCents,5119);assert.equal(f.balanceCents,4119);assert.equal(f.employerCostCents,5996);assert.ok(f.warnings.length>0);
  assert.equal(c.pCalculateFinance_(summary,{rate:17.5,contributionsConfirmed:false}).dueCents,null);
});
test('échéance avant-dernier jour et rappels exacts sur les mois de 28, 29, 30 et 31 jours',()=>{
  const c=domain();
  for(const [month,deadline,reminders]of [
    ['2027-02','2027-02-27',['2027-02-20','2027-02-24','2027-02-26']],
    ['2028-02','2028-02-28',['2028-02-21','2028-02-25','2028-02-27']],
    ['2026-11','2026-11-29',['2026-11-22','2026-11-26','2026-11-28']],
    ['2026-12','2026-12-30',['2026-12-23','2026-12-27','2026-12-29']]
  ]){
    assert.equal(c.pDeadline_(month),deadline);
    assert.deepEqual(JSON.parse(JSON.stringify(c.pReminderDates_(month))),reminders);
  }
  for(const month of ['2026-00','2026-13','invalid'])assert.throws(()=>c.pDeadline_(month),/mois valide/);
});
test('correction du 5 suivant conservée, y compris au changement d’année',()=>{
  const c=domain();assert.equal(c.pCorrectionDeadline_('2026-11'),'2026-12-05');assert.equal(c.pCorrectionDeadline_('2026-12'),'2027-01-05');
});
test('prévisionnel calculé depuis les seules lignes futures, séparant travail et absences',()=>{
  const c=domain(),rows=[line({date:'2026-11-21'}),line({date:'2026-11-22'}),line({date:'2026-11-29',breakMinutes:15}),line({date:'2026-11-30',type:'ABSENCE'})];
  assert.deepEqual(JSON.parse(JSON.stringify(c.pForecast_(rows,'2026-11-22'))),{lineCount:2,workedMinutes:105,absenceMinutes:120,dates:['2026-11-29','2026-11-30']});
  assert.equal(c.pForecast_(rows,'2026-12-01').lineCount,0);
});

test('activité proposée seulement et plage manuelle ne fabrique aucun attendu ni écart',()=>{
 const c=domain();assert.throws(()=>c.pNormalizeLines_([line({activity:'Payer arbitrairement'})],'2026-10','M1',team,c.pActivities_()),/activité proposée/);
 const rows=c.pNormalizeLines_([line({activity:'Danse'}),line({id:'absence',date:'2026-10-07',activity:'Psychomotricité',type:'ABSENCE'})],'2026-10','M1',team,c.pActivities_());
 const sum=c.pSummarize_(rows,[],[],[],'manual','M1','MANUAL');assert.equal(sum.workedMinutes,120);assert.equal(sum.absenceMinutes,120);assert.equal(sum.expectedMinutes,null);assert.equal(sum.differenceMinutes,null);assert.equal(sum.poolWorkedMinutes,0);assert.equal(sum.manualWorkedMinutes,120);assert.ok(sum.byDate.every(d=>d.expectedMinutes===null&&d.differenceMinutes===null));
});
test('personne piscine avec activité complémentaire : baseline piscine intacte et aucune double addition',()=>{
 const c=domain(),rows=[line(),line({id:'dance',date:'2026-10-07',activity:'Danse'})];
 const sum=c.pSummarize_(rows,[line()],[],[],'pool','M1','POOL');assert.equal(sum.expectedMinutes,120);assert.equal(sum.poolWorkedMinutes,120);assert.equal(sum.manualWorkedMinutes,120);assert.equal(sum.workedMinutes,240);assert.equal(sum.payableMinutes,240);assert.equal(sum.differenceMinutes,0);
 assert.equal(sum.byDate[1].poolWorkedMinutes,0);assert.equal(sum.byDate[1].manualWorkedMinutes,120);
});
