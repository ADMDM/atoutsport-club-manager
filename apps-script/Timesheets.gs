/* Parcours de déclaration ; les mutations sont verrouillées par portalRpc. */
function pReviewer_(actor) {return actor&&P_REVIEW_ROLES_.includes(actor.role);}
function pRequireDirector_(actor) {if(!actor||actor.role!=='DIRECTOR')throw new Error('Cette action est réservée à la direction.');}
function pTargetMonitor_(actor,payload,ownOnly) {
  const id=String(payload.monitorId||actor.monitorId||'');
  if(!id||(!pReviewer_(actor)||ownOnly)&&id!==actor.monitorId)throw new Error('Accès à cette fiche non autorisé.');
  const person=pPeople_().find(m=>m.id===id);
  if(!person)throw new Error('Personne introuvable dans l’équipe.');
  if(ownOnly&&!person.active)throw new Error('Cette personne est inactive.');
  return id;
}
function pSheetContext_(sheet,month,monitorId) {
  const sourceMode=sheet?(sheet.sourceMode||'POOL'):pSourceMode_(monitorId);
  if(!['POOL','MANUAL'].includes(sourceMode))throw new Error('Mode de fiche inconnu. Contactez le support.');
  let expected=sheet&&sheet.expectedSnapshot;
  if(!expected){
    if(sourceMode==='MANUAL')expected=[];
    else {
      if(pSourceMode_(monitorId)!=='POOL')throw new Error('Cette ancienne fiche piscine nécessite un rapprochement par la direction.');
      expected=pExpected_(month,monitorId);
    }
  }
  if(sourceMode==='MANUAL'&&expected.length)throw new Error('Une fiche manuelle ne peut pas contenir de planning piscine.');
  return {sourceMode,expected,activities:[...new Set([...pActivities_(),...expected.map(line=>String(line.activity||'Natation'))])],poolBaselineActivities:sourceMode==='POOL'?pPoolActivities_(expected):[]};
}
function pNormalizeSheetLines_(input,month,monitorId,context) {
  if(!Array.isArray(input))throw new Error('Les prestations doivent être une liste de plages.');
  if(context.sourceMode==='MANUAL'&&input.some(line=>!line||!String(line.activity||'').trim()))throw new Error('Choisissez une activité pour chaque plage.');
  return pNormalizeLines_(input,month,monitorId,pPeople_(),context.activities);
}
function pFindSheet_(month,monitorId) {
  const found=pRows_('TIMESHEETS').filter(s=>s.month===month&&s.monitorId===monitorId);
  if(found.length>1)throw new Error('Plusieurs fiches existent pour ce mois. Contactez le support.');
  return found[0]||null;
}
function pReadSheet_(actor,id) {
  const sheet=pGet_('TIMESHEETS',String(id||''));
  if(!sheet||!pReviewer_(actor)&&sheet.monitorId!==actor.monitorId)throw new Error('Fiche introuvable ou non autorisée.');
  return sheet;
}
function pCheckRevision_(record,revision) {
  if(!Number.isSafeInteger(revision)||revision!==(record?record.revision:0))throw new Error('La fiche a changé. Rechargez-la avant de continuer.');
}
function pHasSubmission_(sheet) {return Boolean(sheet&&(sheet.firstSubmittedAt||sheet.submittedAt||Number(sheet.submissionCount)>0));}
function pCanEditSheet_(actor,sheet) {
  if(!actor||sheet.monitorId!==actor.monitorId||sheet.status==='APPROVED'||!pPeople_().some(person=>person.id===sheet.monitorId&&person.active))return false;
  if(sheet.status==='RETURNED')return true;
  if(sheet.status==='SUBMITTED'||sheet.status==='DRAFT'&&pHasSubmission_(sheet))return pToday_()<=pCorrectionDeadline_(sheet.month);
  return sheet.status==='DRAFT';
}
function pCanSubmitSheet_(actor,sheet,expected,today) {
  if(!['DRAFT','RETURNED'].includes(sheet.status)||!pCanEditSheet_(actor,sheet)||sheet.month>today.slice(0,7))return false;
  if(!(sheet.lines||[]).concat(expected||[]).some(line=>line.date>today))return true;
  return sheet.month===today.slice(0,7)&&today>=pReminderDates_(sheet.month)[0];
}
function pDeclarationDifferences_(lines,expected) {
  const groups=(rows,planned)=>{
    const grouped={};
    for(const line of rows){
      if(line.type==='ABSENCE')continue;
      const type=planned&&(line.replacedMonitorId||String(line.origin||'').startsWith('REMPLACEMENT:'))?'REMPLACEMENT':String(line.type||'NORMAL');
      const date=String(line.date),item=JSON.stringify([String(line.start),String(line.end),Number(line.breakMinutes||0),String(line.activity||'Natation'),type,type==='REMPLACEMENT'?String(line.replacedMonitorId||''):'']);
      (grouped[date]||(grouped[date]=[])).push(item);
    }
    for(const date of Object.keys(grouped))grouped[date].sort();
    return grouped;
  };
  const actual=groups(lines,false),planned=groups(expected,true);
  return [...new Set([...Object.keys(actual),...Object.keys(planned)])].filter(date=>JSON.stringify(actual[date]||[])!==JSON.stringify(planned[date]||[])).sort();
}
function pCheckDeclarationReason_(sheet,lines,expected,sourceMode) {
  const differences=sourceMode==='MANUAL'?[]:pDeclarationDifferences_(pBaselineLines_(lines,expected,sourceMode),expected),note=pTextValue_(sheet.declarationNote,2000,'Justification');
  const unexplained=differences.filter(date=>!lines.some(line=>line.date===date&&String(line.note||'').trim()));
  if(differences.length&&!note&&unexplained.length)throw new Error('Expliquez les changements par rapport au planning dans la justification générale ou dans les commentaires des journées concernées : '+unexplained.join(', ')+'.');
  return {differences,note};
}
function pViewMonth_(actor,month,monitorId) {
  const stored=pFindSheet_(month,monitorId),sheet=stored||{id:monitorId+'__'+month,monitorId,month,status:'DRAFT',revision:0,lines:[],comment:'',declarationNote:'',submittedAt:'',validatedAt:'',expectedSnapshot:null};
  const context=pSheetContext_(stored,month,monitorId),expected=context.expected,sourceMode=context.sourceMode,credits=pRows_('RECOVERIES'),all=pRows_('TIMESHEETS');
  const summary=pSummarize_(sheet.lines,expected,credits,all,sheet.id,monitorId,sourceMode),today=pToday_(),forecast=pForecast_(sheet.lines,today);
  summary.forecastMinutes=forecast.workedMinutes;summary.performedMinutes=summary.workedMinutes-forecast.workedMinutes;
  let finance=null;
  if(pReviewer_(actor)){
    const current=pFinanceSource_(month,monitorId),source=sheet.financeSnapshot?{...sheet.financeSnapshot,paidCents:current.paidCents}:current;
    finance=pCalculateFinance_(summary,source);
    finance.provisional=sheet.status!=='APPROVED';
    if(finance.provisional){
      finance.estimatedGrossCents=finance.grossCents;finance.estimatedDueCents=finance.dueCents;
      finance.grossCents=null;finance.dueCents=null;finance.balanceCents=null;
      finance.warnings.push('Fiche non validée : aucun montant définitif à payer.');
    }
  }
  const safeSheet={...sheet,sourceMode,poolBaselineActivities:context.poolBaselineActivities};delete safeSheet.financeSnapshot;
  return {sheet:safeSheet,today,sourceMode,hasPlanningBaseline:sourceMode==='POOL',activities:context.activities,exists:Boolean(stored),expected,summary,finance,forecast,hasForecast:forecast.lineCount>0,submissionOpensOn:pReminderDates_(month)[0],canSubmit:pCanSubmitSheet_(actor,sheet,expected,today),canApprove:actor.role==='DIRECTOR'&&sheet.status==='SUBMITTED'&&month<today.slice(0,7),canEdit:pCanEditSheet_(actor,sheet),canCorrectSubmission:sheet.status==='SUBMITTED'&&pCanEditSheet_(actor,sheet),canReturn:pReviewer_(actor)&&(sheet.status==='SUBMITTED'||sheet.status==='DRAFT'&&pHasSubmission_(sheet)),requiresResubmission:sheet.status==='DRAFT'&&pHasSubmission_(sheet),deadline:pDeadline_(month),correctionDeadline:pCorrectionDeadline_(month),reminderDates:pReminderDates_(month),late:today>pDeadline_(month)&&['DRAFT','RETURNED'].includes(sheet.status),changedDates:sourceMode==='MANUAL'?[]:pDeclarationDifferences_(pBaselineLines_(sheet.lines,expected,sourceMode),expected)};
}
function pMonth_(actor,payload) {
  const month=pMonthValue_(payload.month),monitorId=pTargetMonitor_(actor,payload,false);
  return pViewMonth_(actor,month,monitorId);
}
function pSaveDraft_(actor,payload) {
  const month=pMonthValue_(payload.month),monitorId=pTargetMonitor_(actor,payload,true),before=pFindSheet_(month,monitorId);
  pCheckRevision_(before,payload.revision);
  if(before&&!pCanEditSheet_(actor,before))throw new Error(before.status==='APPROVED'?'Cette fiche est validée. Une réouverture par la direction est nécessaire.':'Cette fiche a déjà été envoyée et le délai de correction du 5 est dépassé. Demandez une réouverture à un responsable.');
  const context=pSheetContext_(before,month,monitorId),lines=pNormalizeSheetLines_(payload.lines,month,monitorId,context);
  const declarationNote=pTextValue_(payload.declarationNote===undefined?before&&before.declarationNote:payload.declarationNote,2000,'Justification');
  const correcting=before&&before.status==='SUBMITTED';
  const record={...(before||{}),id:before?before.id:monitorId+'__'+month,monitorId,month,sourceMode:context.sourceMode,poolBaselineActivities:context.poolBaselineActivities,status:correcting?'DRAFT':before?before.status:'DRAFT',revision:(before?before.revision:0)+1,lines,declarationNote,comment:before?before.comment||'':'',updatedAt:pNow_(),updatedBy:actor.id,createdAt:before?before.createdAt:pNow_(),submittedAt:before?before.submittedAt||'':'',firstSubmittedAt:before?before.firstSubmittedAt||before.submittedAt||'':'',validatedAt:'',expectedSnapshot:before?before.expectedSnapshot||null:null};
  if(correcting){record.correctedAfterSubmissionAt=pNow_();record.financeSnapshot=null;record.validationSummary=null;}
  pCommit_([{table:'TIMESHEETS',record}],actor,correcting?'CORRIGER_FICHE_ENVOYEE':'ENREGISTRER_BROUILLON');
  return pViewMonth_(actor,month,monitorId);
}
function pSubmit_(actor,payload) {
  const before=pReadSheet_(actor,payload.sheetId);
  if(before.monitorId!==actor.monitorId)throw new Error('Seul le moniteur peut envoyer sa fiche.');
  // Réessayer le même clic ne renvoie pas un second email.
  if(before.status==='SUBMITTED'&&before.submittedFromRevision===payload.revision)return pViewMonth_(actor,before.month,before.monitorId);
  pCheckRevision_(before,payload.revision);
  if(!['DRAFT','RETURNED'].includes(before.status))throw new Error('Fiche déjà envoyée ou validée.');
  if(!pCanEditSheet_(actor,before))throw new Error('Le délai de correction du 5 est dépassé. Un responsable doit demander une correction pour rouvrir la fiche.');
  const today=pToday_();
  if(before.month>today.slice(0,7))throw new Error('Vous ne pouvez pas envoyer une fiche pour un mois futur.');
  const context=pSheetContext_(before,before.month,before.monitorId),lines=pNormalizeSheetLines_(before.lines,before.month,before.monitorId,context);
  const expected=context.expected,forecast=pForecast_(lines,today);
  if(!pCanSubmitSheet_(actor,{...before,lines},expected,today))throw new Error('Les prestations futures restent prévisionnelles. Leur envoi est possible à partir du '+pReminderDates_(before.month)[0]+' (premier rappel), avec confirmation explicite.');
  if(forecast.lineCount&&payload.forecastAcknowledged!==true)throw new Error('Confirmez que les heures futures sont prévisionnelles et devront être corrigées si elles changent, jusqu’au 5 du mois suivant.');
  const justification=pCheckDeclarationReason_(before,lines,expected,context.sourceMode),again=pHasSubmission_(before);
  const record={...before,sourceMode:context.sourceMode,poolBaselineActivities:context.poolBaselineActivities,lines,declarationNote:justification.note,changedDates:justification.differences,status:'SUBMITTED',revision:before.revision+1,submittedFromRevision:before.revision,submittedAt:pNow_(),submittedLate:today>pDeadline_(before.month),forecastAtSubmission:forecast,forecastAcknowledgedAt:forecast.lineCount?pNow_():'',firstSubmittedAt:before.firstSubmittedAt||before.submittedAt||pNow_(),submissionCount:Math.max(Number(before.submissionCount||0),again?1:0)+1,expectedSnapshot:expected,expectedRevision:pHash_(expected),updatedAt:pNow_(),updatedBy:actor.id,validatedAt:'',financeSnapshot:null};
  const appUrl=String(pProperties_().getProperty('APP_URL')||'');
  const link=/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(appUrl)?'\n\nOuvrir le portail : '+appUrl:'';
  const forecastNotice=forecast.lineCount?'\n\nPRÉVISIONNEL : '+forecast.lineCount+' plage(s) future(s), dont '+forecast.workedMinutes+' minutes de travail prévu et '+forecast.absenceMinutes+' minutes d’absence prévue. Ces heures ne sont pas encore effectuées. Dates : '+forecast.dates.join(', ')+'. Validation finale uniquement après la fin du mois.':'';
  const mail=pQueueMail_('sheet-'+record.id+'-'+record.revision,pDirectorEmail_(),(again?'Fiche corrigée à vérifier — ':'Fiche de prestation à vérifier — ')+before.month,actor.name+(again?' a envoyé une nouvelle version de sa fiche':' a envoyé sa fiche')+' de prestation pour '+before.month+'. Retrouvez-la dans le portail AtoutSport.'+forecastNotice+link);
  const summary=pSummarize_(lines,expected,pRows_('RECOVERIES'),pRows_('TIMESHEETS'),record.id,record.monitorId,context.sourceMode);
  const receipt=pReceipt_(actor,record,summary);
  pCommit_([{table:'TIMESHEETS',record},mail,receipt],actor,again?'RENVOYER_FICHE_CORRIGEE':'ENVOYER_FICHE');
  return pViewMonth_(actor,record.month,record.monitorId);
}
function pDashboard_(actor,payload) {
  if(!pReviewer_(actor))throw new Error('Accès réservé aux responsables.');
  const month=pMonthValue_(payload.month),today=pToday_();
  const rows=pPeople_().map(m=>{
    const view=pViewMonth_(actor,month,m.id),s=view.sheet,sum=view.summary,f=view.finance;
    // Le suivi porte sur l’activité du mois, pas sur toute la liste des personnes.
    // Un remplaçant sans horaire habituel reste visible, même marqué inactif.
    const replacementExpected=view.expected.some(line=>(line.replacedMonitorId||String(line.origin||'').startsWith('REMPLACEMENT:'))&&pLineMinutes_(line)>0);
    if(!(sum.workedMinutes>0||m.active&&sum.expectedMinutes>0||replacementExpected))return null;
    return {monitorId:m.id,name:m.name,sourceMode:view.sourceMode,hasPlanningBaseline:view.hasPlanningBaseline,poolWorkedMinutes:sum.poolWorkedMinutes,manualWorkedMinutes:sum.manualWorkedMinutes,status:view.exists?s.status:'MISSING',sheetId:s.id,revision:s.revision,workedMinutes:sum.workedMinutes,performedMinutes:sum.performedMinutes,forecastMinutes:sum.forecastMinutes,forecast:view.forecast,hasForecast:view.hasForecast,expectedMinutes:sum.expectedMinutes,differenceMinutes:sum.differenceMinutes,late:today>pDeadline_(month)&&['DRAFT','RETURNED'].includes(s.status),dueCents:f.dueCents,paidCents:f.paidCents,balanceCents:f.balanceCents,warnings:[...sum.warnings,...f.warnings],active:m.active};
  }).filter(Boolean);
  return {rows,month,deadline:pDeadline_(month),correctionDeadline:pCorrectionDeadline_(month),reminderDates:pReminderDates_(month)};
}
function pCheckReplacementConflicts_(sheet,all) {
  for(const line of sheet.lines.filter(l=>l.type==='REMPLACEMENT')){
    const start=pClockValue_(line.start),end=pClockValue_(line.end);
    for(const other of all.filter(s=>s.status==='APPROVED'&&s.id!==sheet.id))for(const l of other.lines||[]){
      if(l.date!==line.date||pClockValue_(l.start)>=end||pClockValue_(l.end)<=start)continue;
      if(l.type==='REMPLACEMENT'&&l.replacedMonitorId===line.replacedMonitorId)throw new Error('Ce remplacement chevauche un remplacement déjà validé.');
      if(other.monitorId===line.replacedMonitorId&&l.type!=='ABSENCE')throw new Error('La personne remplacée a déjà une prestation validée sur ce créneau. Vérifiez les deux fiches.');
    }
  }
  // La même protection vaut si la fiche du remplacé est validée en second.
  for(const other of all.filter(s=>s.status==='APPROVED'&&s.id!==sheet.id))for(const l of other.lines||[]){
    if(l.type!=='REMPLACEMENT'||l.replacedMonitorId!==sheet.monitorId)continue;
    if(sheet.lines.some(line=>line.type!=='ABSENCE'&&line.date===l.date&&pClockValue_(line.start)<pClockValue_(l.end)&&pClockValue_(line.end)>pClockValue_(l.start)))throw new Error('Un autre moniteur a déjà un remplacement validé sur ce créneau.');
  }
}
function pReview_(actor,payload) {
  const decision=String(payload.decision||'');
  if(decision==='CORRECT')return pCorrectSheetByDirector_(actor,payload);
  if(decision==='RETURN'){if(!pReviewer_(actor))throw new Error('Accès réservé aux responsables.');}else pRequireDirector_(actor);
  if(!['RETURN','APPROVE','REOPEN'].includes(decision))throw new Error('Décision inconnue.');
  const before=pReadSheet_(actor,payload.sheetId);pCheckRevision_(before,payload.revision);
  const comment=pTextValue_(payload.comment,2000,'Commentaire'),all=pRows_('TIMESHEETS'),credits=pRows_('RECOVERIES');
  if(decision==='REOPEN'){
    if(before.status!=='APPROVED'||!comment)throw new Error('Une fiche validée et un motif de réouverture sont requis.');
    const dependent=new Set(credits.filter(r=>r.sourceSheetId===before.id||r.sourceRef==='sheet:'+before.id).map(r=>r.id));
    if(all.some(s=>s.status==='APPROVED'&&s.id!==before.id&&(s.lines||[]).some(l=>dependent.has(l.recoveryId))))throw new Error('Une récupération liée à cette fiche est déjà validée ailleurs. Rouvrez d’abord la fiche qui l’utilise.');
  }else if(before.status!=='SUBMITTED'&&!(decision==='RETURN'&&before.status==='DRAFT'&&pHasSubmission_(before)))throw new Error('Seule une fiche envoyée peut être contrôlée.');
  let record={...before,revision:before.revision+1,comment,updatedAt:pNow_(),updatedBy:actor.id};
  if(decision==='APPROVE'){
    if(before.month>=pToday_().slice(0,7))throw new Error('La validation finale est possible après la fin du mois.');
    const context=pSheetContext_(before,before.month,before.monitorId);
    pNormalizeSheetLines_(before.lines,before.month,before.monitorId,context);
    const summary=pSummarize_(before.lines,context.expected,credits,all,before.id,before.monitorId,context.sourceMode);
    if(summary.unresolvedRecoveries)throw new Error('Associez chaque récupération à une origine vérifiée et un crédit disponible.');
    if(summary.hasPlanningBaseline&&summary.byDate.some(d=>d.differenceMinutes!==0)&&!comment)throw new Error('Expliquez les écarts avec le planning avant validation.');
    pCheckReplacementConflicts_(before,all);
    const financeSource=pFinanceSource_(before.month,before.monitorId);
    if((Number(financeSource.adjustmentsCount||0)>0||Number(financeSource.adjustmentsMinutes||0)!==0||(financeSource.warnings||[]).some(w=>/corrections manuelles/i.test(w)))&&!comment)throw new Error('Expliquez le rapprochement avec les corrections de l’ancien décompte avant validation.');
    pCalculateFinance_(summary,financeSource);
    record={...record,status:'APPROVED',validatedAt:pNow_(),validatedBy:actor.id,financeSnapshot:financeSource,validationSummary:summary};
  }else{
    if(!comment)throw new Error('Un commentaire est requis pour demander une correction.');
    record={...record,status:'RETURNED',validatedAt:'',validatedBy:'',financeSnapshot:null,validationSummary:null};
  }
  pCommit_([{table:'TIMESHEETS',record}],actor,'FICHE_'+decision);
  return pViewMonth_(actor,record.month,record.monitorId);
}
function pRecoveries_(actor,payload) {
  const requested=payload.monitorId?String(payload.monitorId):'';
  if(!pReviewer_(actor)&&requested&&requested!==actor.monitorId)throw new Error('Accès non autorisé.');
  const monitorId=pReviewer_(actor)?requested:actor.monitorId;
  if(!pReviewer_(actor)&&!monitorId)throw new Error('Aucun moniteur associé.');
  const used=pRecoveryUsage_(pRows_('TIMESHEETS'));
  return {rows:pRows_('RECOVERIES').filter(r=>!monitorId||r.monitorId===monitorId).map(r=>({...r,usedMinutes:used[r.id]||0,remainingMinutes:r.minutes-(used[r.id]||0)}))};
}
function pSaveRecovery_(actor,payload) {
  pRequireDirector_(actor);const raw=payload.record||{};
  if(raw.id)throw new Error('Un crédit existant ne peut pas être modifié.');
  const monitorId=pTargetMonitor_(actor,{monitorId:raw.monitorId},false),date=pDateValue_(raw.date),minutes=pNumberValue_(raw.minutes,1,14400,'Crédit en minutes');
  if(!Number.isInteger(minutes))throw new Error('Le crédit doit être exprimé en minutes entières.');
  if(date>pToday_())throw new Error('L’origine ne peut pas être dans le futur.');
  if(typeof raw.paidBefore!=='boolean')throw new Error('Précisez si ces heures ont déjà été rémunérées.');
  const sourceRef=pTextValue_(raw.sourceRef,300,'Référence d’origine'),note=pTextValue_(raw.note,1000,'Justification');
  if(!sourceRef||!note)throw new Error('La référence d’origine et sa justification sont obligatoires.');
  const sourceSheetId=pTextValue_(raw.sourceSheetId,100,'Fiche d’origine');
  if(sourceSheetId){const source=pGet_('TIMESHEETS',sourceSheetId);if(!source||source.monitorId!==monitorId||source.status!=='APPROVED')throw new Error('La fiche d’origine doit être validée pour ce moniteur.');}
  if(pRows_('RECOVERIES').some(r=>r.monitorId===monitorId&&r.sourceRef.toLowerCase()===sourceRef.toLowerCase()))throw new Error('Cette origine possède déjà un crédit.');
  const record={id:pId_(),monitorId,date,minutes,paidBefore:raw.paidBefore,sourceRef,note,sourceSheetId,revision:1,createdAt:pNow_(),createdBy:actor.id};
  pCommit_([{table:'RECOVERIES',record}],actor,'CREER_CREDIT_RECUPERATION');
  return record;
}
function pAssignRecovery_(actor,payload) {
  pRequireDirector_(actor);const before=pReadSheet_(actor,payload.sheetId);pCheckRevision_(before,payload.revision);
  if(before.status!=='SUBMITTED')throw new Error('La fiche doit être envoyée avant le contrôle des récupérations.');
  const line=before.lines.find(l=>l.id===payload.lineId),credit=pGet_('RECOVERIES',String(payload.recoveryId||''));
  if(!line||!['RECUPERATION','RATTRAPAGE_COURS'].includes(line.type)||!credit||credit.monitorId!==before.monitorId)throw new Error('Récupération ou crédit incorrect.');
  if(credit.date>line.date)throw new Error('La récupération ne peut pas précéder son origine.');
  const record={...before,lines:before.lines.map(l=>l.id===line.id?{...l,recoveryId:credit.id}:l),revision:before.revision+1,updatedAt:pNow_(),updatedBy:actor.id};
  const context=pSheetContext_(record,record.month,record.monitorId);
  const summary=pSummarize_(record.lines,context.expected,pRows_('RECOVERIES'),pRows_('TIMESHEETS'),record.id,record.monitorId,context.sourceMode);
  if(summary.warnings.some(w=>w.includes('insuffisant ou déjà utilisé')))throw new Error('Le crédit est insuffisant ou déjà utilisé.');
  pCommit_([{table:'TIMESHEETS',record}],actor,'ASSOCIER_RECUPERATION');
  return pViewMonth_(actor,record.month,record.monitorId);
}
