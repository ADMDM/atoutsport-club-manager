function doGet(){const html=HtmlService.createHtmlOutputFromFile('Index').getContent(),correction=HtmlService.createHtmlOutputFromFile('DirectorCorrectionUi').getContent();return HtmlService.createHtmlOutput(html.replace(/<\/body>/i,correction+'</body>')).setTitle('AtoutSport — Gestion administrative').addMetaTag('viewport','width=device-width, initial-scale=1, viewport-fit=cover');}
function portalRpc(token,action,payload){
 try{
  const routes={bootstrap:pBootstrap_,month:pMonth_,saveDraft:pSaveDraft_,submit:pSubmit_,dashboard:pDashboard_,review:pReview_,recoveries:pRecoveries_,saveRecovery:pSaveRecovery_,assignRecovery:pAssignRecovery_,documents:pDocuments_,uploadDocument:pUploadDocument_,downloadDocument:pDownloadDocument_,reviewDocument:pReviewDocument_,users:pUsers_,inviteUser:pInviteUser_,changeUser:pChangeUser_,diagnostic:pDiagnostic_,mailLog:pMailLog_,retryMail:pRetryMail_,legacyUi:pLegacyUi_,legacy:pLegacy_};
  routes.getIdentity=pGetIdentity_;routes.revealIdentity=pRevealIdentity_;routes.submitIdentity=pSubmitIdentity_;routes.reviewIdentity=pReviewIdentity_;
  routes.getProfile=pGetProfile_;routes.saveProfile=pSaveProfile_;routes.requestProfileEmail=pRequestProfileEmail_;
  if(!['activate','completeProfileEmail'].includes(action)&&!Object.prototype.hasOwnProperty.call(routes,action))throw Error('Action inconnue.');
  const identity=pVerifiedIdentity_(token),p=payload&&typeof payload==='object'&&!Array.isArray(payload)?payload:{};
  // Vérifier à nouveau l'état du compte sous verrou : une révocation interdit aussi les appels d'une session déjà ouverte.
  const data=pWithLock_(()=>{
   if(action==='activate')return pActivate_(identity,p);
   // Le nouvel email doit venir de Firebase : le corps client ne fait jamais autorité.
   if(action==='completeProfileEmail')return pCompleteProfileEmail_(identity,p);
   return routes[action](pActor_(identity),p);
  });
  return {ok:true,data};
 }catch(error){return {ok:false,error:error.message||'Opération impossible. Réessayez.'};}
}
function pBootstrap_(actor,p){return {actor,today:pToday_(),month:/^20\d\d-(0[1-9]|1[0-2])$/.test(p.month||'')?p.month:pToday_().slice(0,7),team:pTeam_(),people:pPeople_(),notificationsEnabled:pProperties_().getProperty('APP_EMAIL_ENABLED')==='true'};}
function pDiagnostic_(actor){
 if(!['DIRECTOR','TECHNICAL'].includes(actor.role))throw Error('Accès technique réservé.');
 const out=pRows_('OUTBOX');return {configured:getPortalConfig().configured,notificationsEnabled:pProperties_().getProperty('APP_EMAIL_ENABLED')==='true',pending:out.filter(x=>x.status==='PENDING').length,failed:out.filter(x=>x.status==='FAILED'||x.status==='UNKNOWN').length,sourceCheckedAt:pNow_(),poolMonitors:pTeam_().length,version:'3.4.0'};
}
