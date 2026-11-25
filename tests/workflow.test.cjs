const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const base=path.join(__dirname,'..','apps-script');
const clone=value=>JSON.parse(JSON.stringify(value));
const director={id:'jl',role:'DIRECTOR',name:'la direction',email:'jl@example.test',monitorId:''};
const monitor={id:'one',role:'MONITOR',name:'Adam',email:'one@example.test',monitorId:'M1'};
const other={id:'two',role:'MONITOR',name:'Robin',email:'two@example.test',monitorId:'M2'};
const manager={id:'ol',role:'MANAGER',name:'Alex',monitorId:''};
const tech={...monitor,id:'tech',role:'TECHNICAL'};
const line=(extra={})=>({id:'line1',date:'2026-10-06',start:'09:00',end:'11:00',breakMinutes:0,type:'NORMAL',activity:'Natation',...extra});
function harness(){
  const data={TIMESHEETS:[],RECOVERIES:[],OUTBOX:[]},audit=[];let count=0;
  const c={expected:[line()],today:'2026-11-11',finance:{rate:20,contributionsConfirmed:true,deductionPct:0,chargePct:0,paidCents:0,adjustmentsMinutes:0},pNow_:()=> '2026-11-11T13:00:00Z',pId_:()=> 'id-'+ ++count,pHash_:v=>JSON.stringify(v),pDirectorEmail_:()=> 'jl@example.test',pRows_:name=>clone(data[name]||[]),pGet_:(name,id)=>clone((data[name]||[]).find(r=>r.id===id)||null),pTeam_:()=> [{id:'M1',name:'Adam',active:true},{id:'M2',name:'Robin',active:true}],pQueueMail_:(id,to,subject,text)=>({table:'OUTBOX',record:{id,to,subject,text,revision:1}})};
  c.people=[{id:'M1',name:'Adam',active:true,sourceMode:'POOL'},{id:'M2',name:'Robin',active:true,sourceMode:'POOL'}];c.pPeople_=()=>clone(c.people);c.pSourceMode_=id=>{const p=c.people.find(p=>p.id===id);if(!p)throw Error('Personne introuvable');return p.sourceMode;};
  c.pToday_=()=>c.today;c.pExpected_=()=>clone(c.expected);c.pFinanceSource_=()=>clone(c.finance);
  c.pReceipt_=(actor,sheet,summary)=>({table:'OUTBOX',record:{id:'receipt:'+sheet.id+':'+sheet.revision,to:actor.email,userId:actor.id,subject:'Accusé de réception',text:'Reçu, pas encore validé. '+summary.workedMinutes+' minutes',revision:1}});
  c.pProperties_=()=>({getProperty:key=>key==='APP_URL'?'https://script.google.com/macros/s/test-portal/exec':''});
  c.pCommit_=(changes,actor,action)=>{for(const {table,record}of changes){const rows=data[table]||(data[table]=[]),i=rows.findIndex(r=>r.id===record.id);if(i<0)rows.push(clone(record));else rows[i]=clone(record);}audit.push({actor:actor.id,action});};
  vm.createContext(c);for(const file of ['Domain.gs','Timesheets.gs'])vm.runInContext(fs.readFileSync(path.join(base,file),'utf8'),c);
  return {c,data,audit};
}
function submit(h,lines=[line()],actor=monitor,declarationNote='Prestations vérifiées ; changements expliqués pour le test.'){
  const view=h.c.pSaveDraft_(actor,{month:'2026-10',revision:0,lines,declarationNote});
  return h.c.pSubmit_(actor,{sheetId:view.sheet.id,revision:view.sheet.revision});
}
test('une personne ne peut lire ou modifier les heures d’un autre moniteur',()=>{
  const h=harness();submit(h);
  assert.throws(()=>h.c.pMonth_(other,{month:'2026-10',monitorId:'M1'}),/non autorisé/);
  assert.throws(()=>h.c.pSaveDraft_(manager,{month:'2026-10',monitorId:'M1',revision:1,lines:[]}),/non autorisé/);
  assert.throws(()=>h.c.pDashboard_(tech,{month:'2026-10'}),/responsables/);
  assert.equal(h.c.pMonth_(monitor,{month:'2026-10'}).finance,null);
});
test('identifiant stable et absence de fiche distinguée du brouillon',()=>{
  const h=harness(),view=h.c.pMonth_(monitor,{month:'2026-10'});
  assert.equal(view.sheet.id,'M1__2026-10');assert.equal(view.sheet.revision,0);assert.equal(view.exists,false);
  assert.equal(h.c.pDashboard_(director,{month:'2026-10'}).rows[0].status,'MISSING');
});
test('sauvegarde concurrente rejetée et soumission idempotente avec un seul email par destinataire',()=>{
  const h=harness(),v=h.c.pSaveDraft_(monitor,{month:'2026-10',revision:0,lines:[line()]});
  assert.throws(()=>h.c.pSaveDraft_(monitor,{month:'2026-10',revision:0,lines:[]}),/changé/);
  h.c.pSubmit_(monitor,{sheetId:v.sheet.id,revision:1});h.c.pSubmit_(monitor,{sheetId:v.sheet.id,revision:1});
  assert.equal(h.data.OUTBOX.length,2);assert.equal(h.data.OUTBOX[0].to,'jl@example.test');assert.equal(h.data.OUTBOX[1].to,monitor.email);
  assert.ok(h.data.OUTBOX[0].text.includes('https://script.google.com/macros/s/test-portal/exec'));
  assert.throws(()=>h.c.pSaveDraft_(monitor,{month:'2026-10',revision:2,lines:[]}),/envoyée/);
});
test('le planning de référence reste figé après soumission',()=>{
  const h=harness();submit(h);h.c.expected=[line({end:'13:00'})];
  assert.equal(h.c.pMonth_(monitor,{month:'2026-10'}).summary.expectedMinutes,120);
});
test('prestations futures et heures encore prévues à venir empêchent la soumission',()=>{
  const h=harness();h.c.today='2026-10-05';
  const v=h.c.pSaveDraft_(monitor,{month:'2026-10',revision:0,lines:[line()]});
  assert.throws(()=>h.c.pSubmit_(monitor,{sheetId:v.sheet.id,revision:1}),/futures/);
});
test('seul la direction valide ; le responsable peut demander une correction motivée',()=>{
  const h=harness(),v=submit(h);
  for(const actor of [manager,tech,monitor])assert.throws(()=>h.c.pReview_(actor,{sheetId:v.sheet.id,revision:2,decision:'APPROVE'}),/la direction/);
  assert.throws(()=>h.c.pReview_(manager,{sheetId:v.sheet.id,revision:2,decision:'RETURN',comment:''}),/commentaire/);
  const returned=h.c.pReview_(manager,{sheetId:v.sheet.id,revision:2,decision:'RETURN',comment:'Vérifier le mardi'});
  assert.equal(returned.sheet.status,'RETURNED');assert.equal(h.c.pMonth_(monitor,{month:'2026-10'}).canEdit,true);
});
test('validation figée, décompte personnel accessible, paiements actualisés',()=>{
  const h=harness(),v=submit(h),approved=h.c.pReview_(director,{sheetId:v.sheet.id,revision:2,decision:'APPROVE'});
  assert.equal(approved.sheet.status,'APPROVED');assert.equal(approved.finance.dueCents,4000);assert.equal(approved.sheet.financeSnapshot,undefined);
  h.c.finance.rate=100;h.c.finance.paidCents=1500;
  const seen=h.c.pMonth_(director,{month:'2026-10',monitorId:'M1'});assert.equal(seen.finance.dueCents,4000);assert.equal(seen.finance.balanceCents,2500);
  assert.equal(h.c.pMonth_(monitor,{month:'2026-10'}).sheet.financeSnapshot,undefined);
});
test('écarts opposés sur deux dates nécessitent aussi un commentaire de validation',()=>{
  const h=harness(),v=submit(h,[line({date:'2026-10-07'})]);
  assert.throws(()=>h.c.pReview_(director,{sheetId:v.sheet.id,revision:2,decision:'APPROVE'}),/écarts/);
  assert.equal(h.c.pReview_(director,{sheetId:v.sheet.id,revision:2,decision:'APPROVE',comment:'Cours déplacé'}).sheet.status,'APPROVED');
});
test('récupération payée : création directeur, association, validation, plafond global',()=>{
  const h=harness();h.c.expected=[];
  assert.throws(()=>h.c.pSaveRecovery_(monitor,{record:{}}),/la direction/);
  const credit=h.c.pSaveRecovery_(director,{record:{monitorId:'M1',date:'2026-09-01',minutes:120,paidBefore:true,sourceRef:'paiement-septembre-1',note:'Deux heures déjà réglées en septembre'}});
  const v=submit(h,[line({type:'RECUPERATION',sourceRef:'septembre'})]);
  assert.throws(()=>h.c.pReview_(director,{sheetId:v.sheet.id,revision:2,decision:'APPROVE',comment:'Récupération'}),/Associez/);
  const assigned=h.c.pAssignRecovery_(director,{sheetId:v.sheet.id,revision:2,lineId:'line1',recoveryId:credit.id});
  const approved=h.c.pReview_(director,{sheetId:v.sheet.id,revision:assigned.sheet.revision,decision:'APPROVE',comment:'Récupération vérifiée'});
  assert.equal(approved.summary.workedMinutes,120);assert.equal(approved.finance.dueCents,0);
  assert.equal(h.c.pRecoveries_(monitor,{}).rows[0].remainingMinutes,0);
  assert.throws(()=>h.c.pSaveRecovery_(director,{record:{monitorId:'M1',date:'2026-09-01',minutes:120,paidBefore:true,sourceRef:'PAIEMENT-SEPTEMBRE-1',note:'Dupliqué'}}),/déjà/);
});
test('rattrapage de cours sans crédit ne peut pas être validé',()=>{
  const h=harness(),v=submit(h,[line({type:'RATTRAPAGE_COURS',sourceRef:'cours-septembre'})]);
  assert.throws(()=>h.c.pReview_(director,{sheetId:v.sheet.id,revision:2,decision:'APPROVE'}),/Associez/);
});
test('réouverture exige un motif et préserve la traçabilité',()=>{
  const h=harness(),v=submit(h);h.c.pReview_(director,{sheetId:v.sheet.id,revision:2,decision:'APPROVE'});
  assert.throws(()=>h.c.pReview_(director,{sheetId:v.sheet.id,revision:3,decision:'REOPEN'}),/motif/);
  const r=h.c.pReview_(director,{sheetId:v.sheet.id,revision:3,decision:'REOPEN',comment:'Erreur identifiée'});assert.equal(r.sheet.status,'RETURNED');assert.equal(r.sheet.revision,4);assert.ok(h.audit.some(e=>e.action==='FICHE_REOPEN'));
});
test('deux déclarations contradictoires de remplacement sont détectées',()=>{
  const h=harness(),v=submit(h,[line({type:'REMPLACEMENT',sourceRef:'cours-M2',replacedMonitorId:'M2'})]);
  h.data.TIMESHEETS.push({id:'other',month:'2026-10',monitorId:'M2',status:'APPROVED',revision:1,lines:[line()]});
  assert.throws(()=>h.c.pReview_(director,{sheetId:v.sheet.id,revision:2,decision:'APPROVE'}),/personne remplacée/);
});
test('les fiches manquantes après le 5 sont signalées en retard',()=>{
  const h=harness();assert.ok(h.c.pDashboard_(manager,{month:'2026-10'}).rows.every(r=>r.late));
});
test('fiche non validée : aucun solde financier définitif même si un paiement existe',()=>{
  const h=harness();h.c.finance.paidCents=1500;
  const absent=h.c.pMonth_(director,{month:'2026-10',monitorId:'M1'});
  assert.equal(absent.finance.dueCents,null);assert.equal(absent.finance.balanceCents,null);assert.equal(absent.finance.paidCents,1500);
  submit(h);const submitted=h.c.pMonth_(director,{month:'2026-10',monitorId:'M1'});
  assert.equal(submitted.finance.estimatedDueCents,4000);assert.equal(submitted.finance.dueCents,null);
});
test('rapprochement des corrections v2 demandé avant validation sans addition automatique',()=>{
  const h=harness(),v=submit(h);h.c.finance.adjustmentsMinutes=30;
  assert.throws(()=>h.c.pReview_(director,{sheetId:v.sheet.id,revision:2,decision:'APPROVE'}),/corrections/);
  const ok=h.c.pReview_(director,{sheetId:v.sheet.id,revision:2,decision:'APPROVE',comment:'Correction v2 incluse dans les heures déclarées'});assert.equal(ok.finance.dueCents,4000);
});
test('corrections anciennes qui se compensent exigent encore un rapprochement',()=>{
  const h=harness(),v=submit(h);h.c.finance.adjustmentsMinutes=0;h.c.finance.adjustmentsCount=2;h.c.finance.warnings=[];
  assert.throws(()=>h.c.pReview_(director,{sheetId:v.sheet.id,revision:2,decision:'APPROVE'}),/corrections/);
});
test('une URL de portail invalide n’est pas incluse dans la notification de soumission',()=>{
  const h=harness();h.c.pProperties_=()=>({getProperty:()=> 'javascript:alert(1)'});submit(h);assert.ok(!h.data.OUTBOX[0].text.includes('javascript:'));
});
test('impossible de soumettre une fiche vide d’un mois futur',()=>{
  const h=harness();h.c.expected=[];
  const v=h.c.pSaveDraft_(monitor,{month:'2026-12',revision:0,lines:[]});
  assert.throws(()=>h.c.pSubmit_(monitor,{sheetId:v.sheet.id,revision:1}),/mois futur/);
});
test('réouverture bloquée si le mois sert d’origine à une récupération validée ailleurs',()=>{
  const h=harness(),v=submit(h);h.c.pReview_(director,{sheetId:v.sheet.id,revision:2,decision:'APPROVE'});
  const credit=h.c.pSaveRecovery_(director,{record:{monitorId:'M1',date:'2026-10-06',minutes:60,paidBefore:true,sourceRef:'origine-1',sourceSheetId:v.sheet.id,note:'Heure déjà payée'}});
  h.data.TIMESHEETS.push({id:'next',month:'2026-11',monitorId:'M1',status:'APPROVED',revision:1,lines:[line({type:'RECUPERATION',recoveryId:credit.id,end:'10:00'})]});
  assert.throws(()=>h.c.pReview_(director,{sheetId:v.sheet.id,revision:3,decision:'REOPEN',comment:'Correction'}),/déjà validée ailleurs/);
});
test('horaire exact confirmé sans changement : aucune justification supplémentaire exigée',()=>{
  const h=harness(),v=submit(h,[line()],monitor,'');assert.equal(v.sheet.status,'SUBMITTED');assert.equal(v.sheet.declarationNote,'');assert.equal(v.changedDates.length,0);assert.equal(h.data.OUTBOX.length,2);
});
test('durée égale mais heures déplacées : justification obligatoire côté serveur',()=>{
  const h=harness(),v=h.c.pSaveDraft_(monitor,{month:'2026-10',revision:0,lines:[line({start:'10:00',end:'12:00'})]});
  assert.throws(()=>h.c.pSubmit_(monitor,{sheetId:v.sheet.id,revision:1}),/Expliquez les changements/);assert.equal(h.data.OUTBOX.length,0);assert.equal(h.data.TIMESHEETS[0].status,'DRAFT');
  const fixed=h.c.pSaveDraft_(monitor,{month:'2026-10',revision:1,lines:v.sheet.lines,declarationNote:'Cours décalé à la demande du responsable'});
  assert.equal(h.c.pSubmit_(monitor,{sheetId:v.sheet.id,revision:fixed.sheet.revision}).sheet.status,'SUBMITTED');
});
test('heures identiques mais nature de prestation changée : justification obligatoire',()=>{
  for(const type of ['SUPPLEMENT','REMPLACEMENT','RECUPERATION','RATTRAPAGE_COURS']){
    const h=harness(),v=h.c.pSaveDraft_(monitor,{month:'2026-10',revision:0,lines:[line({type,replacedMonitorId:'M2',sourceRef:'Séance concernée'})]});
    assert.throws(()=>h.c.pSubmit_(monitor,{sheetId:v.sheet.id,revision:v.sheet.revision}),/Expliquez les changements/,type);
    assert.equal(h.data.OUTBOX.length,0);
  }
});
test('remplacement prérempli confirmé sans note mais personne remplacée différente à justifier',()=>{
  const h=harness();h.c.expected=[line({origin:'REMPLACEMENT:EX1',replacedMonitorId:'M2'})];
  const exact=submit(h,[line({type:'REMPLACEMENT',replacedMonitorId:'M2',sourceRef:'REMPLACEMENT:EX1'})],monitor,'');
  assert.equal(exact.changedDates.length,0);
  const changed=harness();changed.c.expected=[line({origin:'REMPLACEMENT:EX1',replacedMonitorId:'M3'})];
  const v=changed.c.pSaveDraft_(monitor,{month:'2026-10',revision:0,lines:[line({type:'REMPLACEMENT',replacedMonitorId:'M2',sourceRef:'Autre séance'})]});
  assert.throws(()=>changed.c.pSubmit_(monitor,{sheetId:v.sheet.id,revision:v.sheet.revision}),/Expliquez les changements/);
});
test('notes des journées concernées suffisantes, mais suppression complète d’un jour à justifier',()=>{
  const h=harness(),sent=submit(h,[line({end:'12:00',note:'Remplacement imprévu en fin de séance'})],monitor,'');assert.equal(sent.sheet.status,'SUBMITTED');
  const absent=harness(),draft=absent.c.pSaveDraft_(monitor,{month:'2026-10',revision:0,lines:[],declarationNote:''});
  assert.throws(()=>absent.c.pSubmit_(monitor,{sheetId:draft.sheet.id,revision:1}),/2026-10-06/);
});
test('jusqu’au 5 inclus, correction d’une fiche envoyée puis resoumission notifiée sans approbation automatique',()=>{
  const h=harness();h.c.today='2026-11-05';const v=submit(h),before=h.c.pMonth_(monitor,{month:'2026-10'});
  assert.equal(before.canEdit,true);assert.equal(before.canCorrectSubmission,true);assert.equal(before.correctionDeadline,'2026-11-05');
  const corrected=h.c.pSaveDraft_(monitor,{month:'2026-10',revision:v.sheet.revision,lines:[line({end:'12:00'})],declarationNote:'Une heure supplémentaire oubliée'});
  assert.equal(corrected.sheet.status,'DRAFT');assert.equal(corrected.requiresResubmission,true);assert.equal(h.data.OUTBOX.length,2);assert.ok(h.audit.some(a=>a.action==='CORRIGER_FICHE_ENVOYEE'));
  assert.throws(()=>h.c.pReview_(director,{sheetId:v.sheet.id,revision:v.sheet.revision,decision:'APPROVE'}),/changé/);
  assert.throws(()=>h.c.pReview_(director,{sheetId:v.sheet.id,revision:corrected.sheet.revision,decision:'APPROVE',comment:'Vérifié'}),/envoyée/);
  const resubmitted=h.c.pSubmit_(monitor,{sheetId:v.sheet.id,revision:corrected.sheet.revision});
  assert.equal(resubmitted.sheet.status,'SUBMITTED');assert.equal(resubmitted.sheet.submissionCount,2);assert.equal(h.data.OUTBOX.length,4);assert.ok(h.data.OUTBOX[2].subject.includes('corrigée'));
  h.c.pSubmit_(monitor,{sheetId:v.sheet.id,revision:corrected.sheet.revision});assert.equal(h.data.OUTBOX.length,4);
});
test('le 6 : fiche envoyée bloquée, y compris brouillon de correction commencé le 5',()=>{
  const h=harness();h.c.today='2026-11-05';const v=submit(h);
  h.c.today='2026-11-06';assert.equal(h.c.pMonth_(monitor,{month:'2026-10'}).canEdit,false);
  assert.throws(()=>h.c.pSaveDraft_(monitor,{month:'2026-10',revision:v.sheet.revision,lines:[line()]}),/délai/);
  h.c.today='2026-11-05';const correction=h.c.pSaveDraft_(monitor,{month:'2026-10',revision:v.sheet.revision,lines:[line()]});
  h.c.today='2026-11-06';assert.equal(h.c.pMonth_(monitor,{month:'2026-10'}).canEdit,false);
  assert.throws(()=>h.c.pSaveDraft_(monitor,{month:'2026-10',revision:correction.sheet.revision,lines:[line()]}),/délai/);
  assert.throws(()=>h.c.pSubmit_(monitor,{sheetId:v.sheet.id,revision:correction.sheet.revision}),/délai/);
  const adminView=h.c.pMonth_(manager,{month:'2026-10',monitorId:'M1'});assert.equal(adminView.canReturn,true);
  const returned=h.c.pReview_(manager,{sheetId:v.sheet.id,revision:correction.sheet.revision,decision:'RETURN',comment:'Correction autorisée après contrôle'});
  assert.equal(h.c.pMonth_(monitor,{month:'2026-10'}).canEdit,true);
  assert.equal(h.c.pSubmit_(monitor,{sheetId:v.sheet.id,revision:returned.sheet.revision}).sheet.status,'SUBMITTED');
});
test('une fiche approuvée reste verrouillée même avant le 5',()=>{
  const h=harness();h.c.today='2026-11-04';const v=submit(h);const approved=h.c.pReview_(director,{sheetId:v.sheet.id,revision:v.sheet.revision,decision:'APPROVE'});
  assert.equal(h.c.pMonth_(monitor,{month:'2026-10'}).canEdit,false);assert.equal(h.c.pMonth_(monitor,{month:'2026-10'}).canCorrectSubmission,false);
  assert.throws(()=>h.c.pSaveDraft_(monitor,{month:'2026-10',revision:approved.sheet.revision,lines:[line()]}),/la direction/);
});
test('une ancienne fiche envoyée sans compteur conserve la première soumission lors d’une correction',()=>{
  const h=harness();h.c.today='2026-11-05';const sent=submit(h);delete h.data.TIMESHEETS[0].submissionCount;delete h.data.TIMESHEETS[0].firstSubmittedAt;
  const corrected=h.c.pSaveDraft_(monitor,{month:'2026-10',revision:sent.sheet.revision,lines:[line()]});
  const resubmitted=h.c.pSubmit_(monitor,{sheetId:sent.sheet.id,revision:corrected.sheet.revision});
  assert.equal(resubmitted.sheet.submissionCount,2);assert.equal(resubmitted.sheet.firstSubmittedAt,sent.sheet.submittedAt);
});
test('correction et resoumission ne modifient pas silencieusement le planning initial figé',()=>{
  const h=harness();h.c.today='2026-11-05';const v=submit(h);h.c.expected=[line({end:'14:00'})];
  const changed=h.c.pSaveDraft_(monitor,{month:'2026-10',revision:v.sheet.revision,lines:[line({end:'12:00'})],declarationNote:'Une heure supplémentaire'});
  const resubmitted=h.c.pSubmit_(monitor,{sheetId:v.sheet.id,revision:changed.sheet.revision});
  assert.equal(resubmitted.summary.expectedMinutes,120);assert.equal(resubmitted.summary.workedMinutes,180);assert.equal(resubmitted.sheet.expectedSnapshot[0].end,'11:00');
});
test('une première déclaration tardive reste acceptée et ne devient jamais une approbation',()=>{
  const h=harness();h.c.today='2026-11-11';const v=submit(h);
  assert.equal(v.sheet.status,'SUBMITTED');assert.equal(v.canEdit,false);assert.equal(v.sheet.submissionCount,1);assert.equal(v.sheet.validatedAt,'');assert.equal(h.data.OUTBOX[1].to,monitor.email);
});
test('API distingue échéance d’envoi, correction et trois rappels pour la fiche et le tableau de bord',()=>{
  const h=harness(),view=h.c.pMonth_(monitor,{month:'2026-11'}),board=h.c.pDashboard_(director,{month:'2026-11'});
  for(const value of [view,board]){
    assert.equal(value.deadline,'2026-11-29');assert.equal(value.correctionDeadline,'2026-12-05');
    assert.deepEqual(clone(value.reminderDates),['2026-11-22','2026-11-26','2026-11-28']);
  }
});
test('échéance organisationnelle : retard signalé après le jour limite sans empêcher la remise ni la correction',()=>{
  const h=harness();h.c.today='2026-10-30';
  assert.equal(h.c.pMonth_(monitor,{month:'2026-10'}).late,false);assert.equal(h.c.pDashboard_(director,{month:'2026-10'}).rows[0].late,false);
  h.c.today='2026-10-31';assert.equal(h.c.pMonth_(monitor,{month:'2026-10'}).late,true);assert.equal(h.c.pDashboard_(director,{month:'2026-10'}).rows[0].late,true);
  const submitted=submit(h);assert.equal(submitted.sheet.submittedLate,true);assert.equal(submitted.late,false);assert.equal(submitted.canCorrectSubmission,true);
  assert.equal(h.c.pDashboard_(director,{month:'2026-10'}).rows[0].late,false);
  h.c.today='2026-11-05';const corrected=h.c.pSaveDraft_(monitor,{month:'2026-10',revision:submitted.sheet.revision,lines:[line()],declarationNote:'Vérifié'});
  assert.equal(corrected.late,true);assert.equal(h.c.pSubmit_(monitor,{sheetId:corrected.sheet.id,revision:corrected.sheet.revision}).sheet.status,'SUBMITTED');
});
test('fiche remise au jour limite reste dans les temps ; heures de dernier jour acceptées seulement comme prévisionnelles',()=>{
  const h=harness();h.c.today='2026-10-30';assert.equal(submit(h).sheet.submittedLate,false);
  const last=harness();last.c.today='2026-10-30';last.c.expected=[line({date:'2026-10-31'})];
  const draft=last.c.pSaveDraft_(monitor,{month:'2026-10',revision:0,lines:last.c.expected});
  assert.equal(draft.hasForecast,true);assert.equal(draft.canSubmit,true);assert.equal(draft.summary.performedMinutes,0);assert.equal(draft.summary.forecastMinutes,120);
  assert.throws(()=>last.c.pSubmit_(monitor,{sheetId:draft.sheet.id,revision:draft.sheet.revision}),/Confirmez/);
  const sent=last.c.pSubmit_(monitor,{sheetId:draft.sheet.id,revision:draft.sheet.revision,forecastAcknowledged:true});
  assert.equal(sent.sheet.submittedLate,false);assert.equal(sent.sheet.forecastAtSubmission.workedMinutes,120);assert.ok(sent.sheet.forecastAcknowledgedAt);assert.equal(sent.sheet.status,'SUBMITTED');
  assert.match(last.data.OUTBOX[0].text,/PRÉVISIONNEL/);assert.match(last.data.OUTBOX[0].text,/120 minutes/);assert.match(last.data.OUTBOX[0].text,/2026-10-31/);
  assert.equal(last.c.pMonth_(director,{month:'2026-10',monitorId:'M1'}).canApprove,false);
  assert.throws(()=>last.c.pReview_(director,{sheetId:sent.sheet.id,revision:sent.sheet.revision,decision:'APPROVE'}),/fin du mois/);
  last.c.today='2026-11-01';const after=last.c.pMonth_(director,{month:'2026-10',monitorId:'M1'});
  assert.equal(after.today,'2026-11-01');assert.equal(after.hasForecast,false);assert.equal(after.summary.performedMinutes,120);assert.equal(after.canApprove,true);
  assert.equal(after.sheet.forecastAtSubmission.workedMinutes,120);
});
test('prévisionnel à partir du premier rappel uniquement, jamais pour un mois futur même avec confirmation',()=>{
  const h=harness();h.c.today='2026-11-21';h.c.expected=[line({date:'2026-11-30'})];
  const draft=h.c.pSaveDraft_(monitor,{month:'2026-11',revision:0,lines:h.c.expected});
  assert.equal(draft.submissionOpensOn,'2026-11-22');assert.equal(draft.canSubmit,false);
  assert.throws(()=>h.c.pSubmit_(monitor,{sheetId:draft.sheet.id,revision:draft.sheet.revision,forecastAcknowledged:true}),/2026-11-22/);
  h.c.today='2026-11-22';assert.equal(h.c.pMonth_(monitor,{month:'2026-11'}).canSubmit,true);
  for(const invalid of [undefined,false,'true',1])assert.throws(()=>h.c.pSubmit_(monitor,{sheetId:draft.sheet.id,revision:draft.sheet.revision,forecastAcknowledged:invalid}),/Confirmez/);
  const sent=h.c.pSubmit_(monitor,{sheetId:draft.sheet.id,revision:draft.sheet.revision,forecastAcknowledged:true});assert.equal(sent.sheet.status,'SUBMITTED');
  const future=harness();future.c.today='2026-11-22';future.c.expected=[line({date:'2026-12-30'})];
  const futureDraft=future.c.pSaveDraft_(monitor,{month:'2026-12',revision:0,lines:future.c.expected});assert.equal(futureDraft.canSubmit,false);
  assert.throws(()=>future.c.pSubmit_(monitor,{sheetId:futureDraft.sheet.id,revision:futureDraft.sheet.revision,forecastAcknowledged:true}),/mois futur/);
});
test('prévisionnel ne rajoute aucune ligne et les écarts avec le planning doivent rester justifiés',()=>{
  const h=harness();h.c.today='2026-11-22';h.c.expected=[line({date:'2026-11-30'})];
  const draft=h.c.pSaveDraft_(monitor,{month:'2026-11',revision:0,lines:[]});assert.equal(draft.hasForecast,false);
  assert.throws(()=>h.c.pSubmit_(monitor,{sheetId:draft.sheet.id,revision:draft.sheet.revision,forecastAcknowledged:true}),/Expliquez/);
  const explained=h.c.pSaveDraft_(monitor,{month:'2026-11',revision:draft.sheet.revision,lines:[],declarationNote:'Séance annulée par le responsable'});
  const sent=h.c.pSubmit_(monitor,{sheetId:explained.sheet.id,revision:explained.sheet.revision});assert.equal(sent.sheet.lines.length,0);assert.equal(sent.hasForecast,false);
});
test('tableau direction distingue heures déclarées pour dates écoulées et prévisionnelles, sans montant définitif',()=>{
  const h=harness();h.c.today='2026-11-22';h.c.expected=[line({date:'2026-11-20'}),line({id:'later',date:'2026-11-30',end:'12:00'})];
  const draft=h.c.pSaveDraft_(monitor,{month:'2026-11',revision:0,lines:h.c.expected});
  const sent=h.c.pSubmit_(monitor,{sheetId:draft.sheet.id,revision:draft.sheet.revision,forecastAcknowledged:true});
  const row=h.c.pDashboard_(director,{month:'2026-11'}).rows.find(r=>r.monitorId==='M1');
  assert.equal(row.workedMinutes,300);assert.equal(row.performedMinutes,120);assert.equal(row.forecastMinutes,180);assert.equal(row.forecast.lineCount,1);assert.equal(row.dueCents,null);
  h.c.today='2026-12-05';const changed=h.c.pSaveDraft_(monitor,{month:'2026-11',revision:sent.sheet.revision,lines:[h.c.expected[0],{...h.c.expected[1],type:'ABSENCE'}],declarationNote:'Absence le dernier jour'});
  const resent=h.c.pSubmit_(monitor,{sheetId:changed.sheet.id,revision:changed.sheet.revision});assert.equal(resent.sheet.status,'SUBMITTED');assert.equal(resent.summary.workedMinutes,120);assert.equal(resent.summary.absenceMinutes,180);
});

function manualPerson(h){h.c.people.push({id:'D1',name:'Dana',active:true,sourceMode:'MANUAL'});return {id:'dance-user',role:'MONITOR',name:'Dana',email:'dana@example.test',monitorId:'D1'};}
test('suivi : seuls les moniteurs avec des heures prévues sont à recevoir',()=>{
 const h=harness();h.c.pExpected_=(month,id)=>id==='M1'?[line()]:[];
 const rows=h.c.pDashboard_(director,{month:'2026-10'}).rows;
 assert.deepEqual(clone(rows.map(r=>r.monitorId)),['M1']);assert.equal(rows[0].status,'MISSING');
 assert.equal(rows[0].expectedMinutes,120);assert.equal(rows[0].workedMinutes,0);
 assert.equal(h.data.TIMESHEETS.length,0);assert.equal(h.audit.length,0);
});
test('suivi : brouillons vides et fiches sans heures de travail sont masqués',()=>{
 const h=harness();h.c.expected=[];
 const draft=h.c.pSaveDraft_(monitor,{month:'2026-10',revision:0,lines:[]});
 assert.equal(h.c.pDashboard_(director,{month:'2026-10'}).rows.length,0);
 const absence=submit(h,[line({type:'ABSENCE'})],other,'Aucune séance prévue');
 assert.equal(absence.sheet.status,'SUBMITTED');assert.equal(h.c.pDashboard_(director,{month:'2026-10'}).rows.length,0);
 assert.equal(h.data.TIMESHEETS.length,2);assert.ok(h.c.pMonth_(director,{month:'2026-10',monitorId:'M1'}).exists);
 assert.equal(h.data.TIMESHEETS.find(s=>s.id===draft.sheet.id).revision,1);
});
test('suivi : un remplacement déclaré apparaît sans horaire habituel et malgré la désactivation ultérieure',()=>{
 const h=harness();h.c.expected=[];
 submit(h,[line({type:'REMPLACEMENT',replacedMonitorId:'M2',sourceRef:'Séance remplacée'})]);
 h.c.people[0].active=false;
 const rows=h.c.pDashboard_(director,{month:'2026-10'}).rows;
 assert.deepEqual(clone(rows.map(r=>r.monitorId)),['M1']);assert.equal(rows[0].workedMinutes,120);assert.equal(rows[0].expectedMinutes,0);
});
test('suivi : un remplacement du planning apparaît même sans fiche ni statut actif',()=>{
 const h=harness();h.c.people[0].active=false;
 h.c.pExpected_=(month,id)=>id==='M1'?[line({origin:'REMPLACEMENT:EX1',replacedMonitorId:'M2'})]:[];
 const rows=h.c.pDashboard_(director,{month:'2026-10'}).rows;
 assert.deepEqual(clone(rows.map(r=>r.monitorId)),['M1']);assert.equal(rows[0].status,'MISSING');assert.equal(rows[0].expectedMinutes,120);
});
test('suivi : ancien planning d’un inactif masqué, heures réellement déclarées conservées',()=>{
 const h=harness();submit(h);h.c.people.forEach(p=>p.active=false);
 const rows=h.c.pDashboard_(director,{month:'2026-10'}).rows;
 assert.deepEqual(clone(rows.map(r=>r.monitorId)),['M1']);assert.equal(rows[0].workedMinutes,120);
});
test('suivi : la présence dans la liste est recalculée pour le mois sélectionné',()=>{
 const h=harness();h.c.pExpected_=(month,id)=>month==='2026-10'&&id==='M1'?[line()]:[];
 assert.equal(h.c.pDashboard_(director,{month:'2026-10'}).rows.length,1);
 assert.equal(h.c.pDashboard_(director,{month:'2026-11'}).rows.length,0);
 h.c.pSaveDraft_(other,{month:'2026-11',revision:0,lines:[line({date:'2026-11-05',type:'REMPLACEMENT',replacedMonitorId:'M1',sourceRef:'Séance ponctuelle'})]});
 assert.deepEqual(clone(h.c.pDashboard_(director,{month:'2026-11'}).rows.map(r=>r.monitorId)),['M2']);
 assert.deepEqual(clone(h.c.pDashboard_(director,{month:'2026-10'}).rows.map(r=>r.monitorId)),['M1']);
});
test('suivi : une absence déclarée ne masque pas les heures attendues d’un actif',()=>{
 const h=harness();submit(h,[line({type:'ABSENCE'})]);
 const row=h.c.pDashboard_(director,{month:'2026-10'}).rows.find(r=>r.monitorId==='M1');
 assert.equal(row.expectedMinutes,120);assert.equal(row.workedMinutes,0);assert.equal(row.status,'SUBMITTED');
});
test('fiche manuelle : activité explicite, aucun planning ni justification de faux écart, validation directeur',()=>{
 const h=harness(),actor=manualPerson(h);h.c.pExpected_=()=>{throw Error('Planning piscine interdit pour fiche manuelle');};
 let v=h.c.pMonth_(actor,{month:'2026-10'});assert.equal(v.sourceMode,'MANUAL');assert.equal(v.hasPlanningBaseline,false);assert.equal(v.expected.length,0);assert.equal(v.summary.expectedMinutes,null);
 assert.throws(()=>h.c.pSaveDraft_(actor,{month:'2026-10',revision:0,lines:[line({activity:''})]}),/Choisissez une activité/);
 v=h.c.pSaveDraft_(actor,{month:'2026-10',revision:0,sourceMode:'POOL',lines:[line({activity:'Danse'})]});assert.equal(v.sheet.sourceMode,'MANUAL');assert.deepEqual(clone(v.sheet.poolBaselineActivities),[]);
 v=h.c.pSubmit_(actor,{sheetId:v.sheet.id,revision:v.sheet.revision});assert.equal(v.sheet.status,'SUBMITTED');assert.equal(v.summary.workedMinutes,120);assert.deepEqual(clone(v.changedDates),[]);
 assert.throws(()=>h.c.pReview_(manager,{sheetId:v.sheet.id,revision:v.sheet.revision,decision:'APPROVE'}),/la direction/);
 const approved=h.c.pReview_(director,{sheetId:v.sheet.id,revision:v.sheet.revision,decision:'APPROVE'});assert.equal(approved.finance.dueCents,4000);assert.equal(approved.summary.differenceMinutes,null);
});
test('fiches manuelles restent personnelles, inactifs bloqués et directeur voit les deux modes',()=>{
 const h=harness(),actor=manualPerson(h);
 assert.throws(()=>h.c.pMonth_(monitor,{month:'2026-10',monitorId:'D1'}),/non autorisé/);
 assert.throws(()=>h.c.pSaveDraft_(actor,{month:'2026-10',revision:0,monitorId:'M1',lines:[]}),/non autorisé/);
 assert.ok(!h.c.pDashboard_(director,{month:'2026-10'}).rows.some(r=>r.monitorId==='D1'));
 const draft=h.c.pSaveDraft_(actor,{month:'2026-10',revision:0,lines:[line({activity:'Danse'})]});
 const board=h.c.pDashboard_(director,{month:'2026-10'}),row=board.rows.find(r=>r.monitorId==='D1');assert.equal(row.sourceMode,'MANUAL');assert.equal(row.expectedMinutes,null);assert.equal(row.differenceMinutes,null);
 h.c.pSaveDraft_(actor,{month:'2026-10',revision:draft.sheet.revision,lines:[]});
 h.c.people.find(p=>p.id==='D1').active=false;assert.throws(()=>h.c.pSaveDraft_(actor,{month:'2026-10',revision:0,lines:[]}),/inactive/);
 assert.ok(!h.c.pDashboard_(director,{month:'2026-10'}).rows.some(r=>r.monitorId==='D1'));
});
test('activité complémentaire piscine ne gonfle pas les écarts piscine et mode envoyé non modifiable',()=>{
 const h=harness();let v=h.c.pSaveDraft_(monitor,{month:'2026-10',revision:0,sourceMode:'MANUAL',lines:[line(),line({id:'dance',date:'2026-10-07',activity:'Danse'})]});
 assert.equal(v.sheet.sourceMode,'POOL');assert.equal(v.summary.poolWorkedMinutes,120);assert.equal(v.summary.manualWorkedMinutes,120);assert.equal(v.summary.differenceMinutes,0);
 v=h.c.pSubmit_(monitor,{sheetId:v.sheet.id,revision:v.sheet.revision});assert.equal(v.sheet.status,'SUBMITTED');assert.equal(v.sheet.expectedSnapshot.length,1);assert.equal(v.sheet.expectedSnapshot[0].end,'11:00');
 h.c.people.find(p=>p.id==='M1').sourceMode='MANUAL';assert.equal(h.c.pMonth_(monitor,{month:'2026-10'}).sourceMode,'POOL');
});
test('heures manuelles : chevauchements et récupération non vérifiée restent refusés',()=>{
 const h=harness(),actor=manualPerson(h),dance=line({activity:'Danse'});
 assert.throws(()=>h.c.pSaveDraft_(actor,{month:'2026-10',revision:0,lines:[dance,{...dance,id:'overlap',activity:'Gestion administrative'}]}),/chevauchent/);
 let v=h.c.pSaveDraft_(actor,{month:'2026-10',revision:0,lines:[{...dance,type:'RECUPERATION',sourceRef:'Séance antérieure'}]});v=h.c.pSubmit_(actor,{sheetId:v.sheet.id,revision:v.sheet.revision});
 assert.throws(()=>h.c.pReview_(director,{sheetId:v.sheet.id,revision:v.sheet.revision,decision:'APPROVE'}),/Associez/);
});
