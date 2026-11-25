/* Règles pures du portail piscine. Durées en minutes, montants en centimes. */
const P_TYPES_ = ['NORMAL','ABSENCE','REMPLACEMENT','SUPPLEMENT','RATTRAPAGE_COURS','RECUPERATION'];
const P_REVIEW_ROLES_ = ['DIRECTOR','MANAGER','SECRETARY'];
const P_ACTIVITIES_ = ['Natation','Bébés nageurs','Aquagym','Aquafit','Multisports','Éveil sportif','Psychomotricité','Cyclomotricité','Tennis','VTT','Danse','Danse / Hip-hop','Cuisine','Équitation','Sciences','Garderie','Mini-foot','Zumba kids','Jogging','Zumba','Body Balance','Coaching','Gestion administrative','Comptabilité','Direction','Secrétariat'];
function pActivities_(){return P_ACTIVITIES_.slice();}
function pPoolActivities_(expected){return [...new Set(['Natation','Bébés nageurs','Aquagym','Aquafit',...(expected||[]).map(line=>String(line.activity||'Natation'))])];}
function pBaselineLines_(lines,expected,sourceMode){if(sourceMode==='MANUAL')return [];const activities=new Set(pPoolActivities_(expected));return (lines||[]).filter(line=>activities.has(line.activity||'Natation'));}

function pMonthValue_(value) {
  const month=String(value||'');
  if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))throw new Error('Choisissez un mois valide.');
  return month;
}
function pDateValue_(value) {
  const text=String(value||'');
  if(!/^20\d{2}-\d{2}-\d{2}$/.test(text))throw new Error('Date incorrecte.');
  const date=new Date(text+'T00:00:00Z');
  if(!Number.isFinite(+date)||date.toISOString().slice(0,10)!==text)throw new Error('Date incorrecte.');
  return text;
}
function pTextValue_(value,max,label) {
  const text=String(value==null?'':value).trim();
  if(text.length>max)throw new Error((label||'Texte')+' trop long.');
  return text;
}
function pNumberValue_(value,min,max,label) {
  if(value===''||value==null||typeof value==='boolean')throw new Error((label||'Nombre')+' manquant.');
  const number=Number(value);
  if(!Number.isFinite(number)||number<min||number>max)throw new Error((label||'Nombre')+' incorrect.');
  return number;
}
function pClockValue_(value) {
  const text=String(value||'');
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(text))throw new Error('Heure incorrecte : format HH:MM attendu.');
  return Number(text.slice(0,2))*60+Number(text.slice(3));
}
function pLineMinutes_(line) {
  return pClockValue_(line.end)-pClockValue_(line.start)-Number(line.breakMinutes||0);
}
function pNormalizeLines_(input,month,monitorId,team,allowedActivities) {
  pMonthValue_(month);
  if(!Array.isArray(input)||input.length>120)throw new Error('Une fiche peut contenir au maximum 120 plages.');
  const seen=new Set(),known=new Set((team||[]).map(m=>m.id));
  const result=input.map(raw=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Ligne incorrecte.');
    const id=pTextValue_(raw.id||pId_(),100,'Identifiant');
    if(!/^[A-Za-z0-9_-]+$/.test(id)||seen.has(id))throw new Error('Identifiant de ligne incorrect ou dupliqué.');
    seen.add(id);
    const date=pDateValue_(raw.date);
    if(date.slice(0,7)!==month)throw new Error('Toutes les prestations doivent appartenir au mois choisi.');
    const start=String(raw.start||''),end=String(raw.end||''),from=pClockValue_(start),to=pClockValue_(end);
    if(to<=from)throw new Error('La fin doit être après le début, le même jour.');
    const pause=pNumberValue_(raw.breakMinutes==null?0:raw.breakMinutes,0,to-from-1,'Pause');
    if(!Number.isInteger(pause))throw new Error('La pause est exprimée en minutes entières.');
    const type=String(raw.type||'NORMAL');
    if(!P_TYPES_.includes(type))throw new Error('Type de prestation inconnu.');
    const sourceRef=pTextValue_(raw.sourceRef,300,'Origine'),recoveryId=pTextValue_(raw.recoveryId,100,'Crédit de récupération');
    let replacedMonitorId='';
    if(type==='REMPLACEMENT'){
      replacedMonitorId=String(raw.replacedMonitorId||'');
      if(!known.has(replacedMonitorId)||replacedMonitorId===monitorId)throw new Error('Choisissez la personne remplacée.');
      if(!sourceRef)throw new Error('Précisez la séance ou le créneau remplacé.');
    }
    if(['RECUPERATION','RATTRAPAGE_COURS'].includes(type)&&!sourceRef)throw new Error('Précisez l’origine des heures récupérées ou du cours rattrapé.');
    if(type==='ABSENCE'&&pause!==0)throw new Error('Une absence doit être saisie sans pause ; séparez les plages si nécessaire.');
    const activity=pTextValue_(raw.activity||'Natation',100,'Activité');
    if(allowedActivities&&!allowedActivities.includes(activity))throw new Error('Choisissez une activité proposée.');
    return {id,date,start,end,breakMinutes:pause,type,activity,replacedMonitorId,sourceRef,recoveryId:['RECUPERATION','RATTRAPAGE_COURS'].includes(type)?recoveryId:'',note:pTextValue_(raw.note,1000,'Commentaire')};
  });
  result.sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start)||a.id.localeCompare(b.id));
  for(let i=1;i<result.length;i++){
    if(result[i].date===result[i-1].date&&pClockValue_(result[i].start)<pClockValue_(result[i-1].end))throw new Error('Deux plages se chevauchent le '+result[i].date+'. Séparez les heures travaillées et les absences.');
  }
  return result;
}
function pRecoveryUsage_(sheets,excludeId) {
  const used={};
  for(const sheet of sheets||[]){
    if(sheet.status!=='APPROVED'||sheet.id===excludeId)continue;
    for(const line of sheet.lines||[])if(['RECUPERATION','RATTRAPAGE_COURS'].includes(line.type)&&line.recoveryId)used[line.recoveryId]=(used[line.recoveryId]||0)+pLineMinutes_(line);
  }
  return used;
}
function pSummarize_(lines,expected,credits,sheets,sheetId,monitorId,sourceMode) {
  const mode=sourceMode||'POOL',baseline=new Set(pBaselineLines_(lines,expected,mode));
  const byDay={},warnings=[],creditMap=new Map((credits||[]).map(r=>[r.id,r])),used=pRecoveryUsage_(sheets,sheetId),claims={};
  let worked=0,absent=0,alreadyPaid=0,unresolved=0,expectedTotal=0;
  const day=d=>byDay[d]||(byDay[d]={date:d,expectedMinutes:0,workedMinutes:0,poolWorkedMinutes:0,manualWorkedMinutes:0,absenceMinutes:0,alreadyPaidMinutes:0,payableMinutes:0,differenceMinutes:0});
  const minuteSets={};
  for(const line of expected||[]){
    const d=pDateValue_(line.date),a=pClockValue_(line.start),b=pClockValue_(line.end),pause=Number(line.breakMinutes||0);
    if(b<=a||pause!==0)throw new Error('Planning source non exploitable : vérifiez les plages et pauses.');
    const set=minuteSets[d]||(minuteSets[d]=new Set());for(let i=a;i<b;i++)set.add(i);
  }
  for(const date of Object.keys(minuteSets)){const n=minuteSets[date].size;day(date).expectedMinutes=n;expectedTotal+=n;}
  for(const line of lines||[]){
    const n=pLineMinutes_(line),d=day(line.date);
    if(line.type==='ABSENCE'){absent+=n;d.absenceMinutes+=n;continue;}
    worked+=n;d.workedMinutes+=n;
    if(baseline.has(line))d.poolWorkedMinutes+=n;else d.manualWorkedMinutes+=n;
    if(['RECUPERATION','RATTRAPAGE_COURS'].includes(line.type)){
      const credit=creditMap.get(line.recoveryId);
      if(!credit||credit.monitorId!==monitorId){unresolved++;warnings.push('Récupération du '+line.date+' : origine et paiement à confirmer par la direction.');continue;}
      if(pDateValue_(credit.date)>line.date){unresolved++;warnings.push('Récupération du '+line.date+' antérieure à son origine.');continue;}
      claims[credit.id]=(claims[credit.id]||0)+n;
      if(credit.paidBefore===true){alreadyPaid+=n;d.alreadyPaidMinutes+=n;}
    }
  }
  for(const id of Object.keys(claims))if((used[id]||0)+claims[id]>creditMap.get(id).minutes){unresolved++;warnings.push('Le crédit de récupération '+id+' est insuffisant ou déjà utilisé.');}
  const rows=Object.values(byDay).sort((a,b)=>a.date.localeCompare(b.date));
  for(const d of rows){d.payableMinutes=d.workedMinutes-d.alreadyPaidMinutes;d.differenceMinutes=mode==='MANUAL'?null:d.poolWorkedMinutes-d.expectedMinutes;if(mode==='MANUAL')d.expectedMinutes=null;}
  const poolWorked=rows.reduce((sum,d)=>sum+d.poolWorkedMinutes,0),manualWorked=rows.reduce((sum,d)=>sum+d.manualWorkedMinutes,0);
  return {sourceMode:mode,hasPlanningBaseline:mode!=='MANUAL',workedMinutes:worked,poolWorkedMinutes:poolWorked,manualWorkedMinutes:manualWorked,absenceMinutes:absent,alreadyPaidMinutes:alreadyPaid,payableMinutes:worked-alreadyPaid,expectedMinutes:mode==='MANUAL'?null:expectedTotal,differenceMinutes:mode==='MANUAL'?null:poolWorked-expectedTotal,byDate:rows,warnings:[...new Set(warnings)],unresolvedRecoveries:unresolved};
}
function pCalculateFinance_(summary,source) {
  source=source||{};
  const warnings=[...(source.warnings||[])],paid=Number(source.paidCents||0);
  if(!Number.isSafeInteger(paid)||paid<0)throw new Error('Paiements source incohérents.');
  let rate=null,gross=null,due=null,cost=null;
  if(source.rate!==null&&source.rate!==undefined&&source.rate!=='')rate=pNumberValue_(source.rate,0,1000,'Tarif horaire');
  else warnings.push('Tarif horaire à compléter dans la gestion administrative.');
  if(summary.unresolvedRecoveries)warnings.push('Montant à calculer après vérification des récupérations.');
  else if(rate!==null){
    gross=Math.round(summary.payableMinutes*rate*100/60);
    if(source.contributionsConfirmed===true){
      const deduction=pNumberValue_(source.deductionPct,0,100,'Retenue'),charge=pNumberValue_(source.chargePct,0,100,'Charge employeur');
      due=gross-Math.round(gross*deduction/100);cost=gross+Math.round(gross*charge/100);
    }else warnings.push('Retenues et charges à confirmer dans la gestion administrative.');
  }
  if(Number(source.adjustmentsMinutes||0)!==0)warnings.push('Des corrections existent dans l’ancien décompte : elles ne sont pas additionnées une deuxième fois à cette déclaration.');
  return {rate,grossCents:gross,dueCents:due,paidCents:paid,balanceCents:due===null?null:due-paid,employerCostCents:cost,warnings:[...new Set(warnings)]};
}
function pDeadline_(month) {
  pMonthValue_(month);const d=new Date(month+'-01T00:00:00Z');
  // Calcul calendaire indépendant de l'heure d'été ; le jour courant est celui de Bruxelles.
  return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,-1)).toISOString().slice(0,10);
}
function pCorrectionDeadline_(month) {
  pMonthValue_(month);const d=new Date(month+'-01T00:00:00Z');
  return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,5)).toISOString().slice(0,10);
}
function pReminderDates_(month) {
  const deadline=new Date(pDeadline_(month)+'T00:00:00Z');
  return [7,3,1].map(days=>new Date(+deadline-days*86400000).toISOString().slice(0,10));
}
function pForecast_(lines,today) {
  pDateValue_(today);
  const future=(lines||[]).filter(line=>pDateValue_(line.date)>today);
  return {lineCount:future.length,workedMinutes:future.filter(l=>l.type!=='ABSENCE').reduce((sum,line)=>sum+pLineMinutes_(line),0),absenceMinutes:future.filter(l=>l.type==='ABSENCE').reduce((sum,line)=>sum+pLineMinutes_(line),0),dates:[...new Set(future.map(line=>line.date))].sort()};
}
