/* Installation publique : nouveau projet et ressources indépendantes.
 * Ces fonctions finissent par _ : elles ne sont pas exposées à google.script.run.
 * Aucune adresse, donnée, clé ou ressource du club d'origine n'est intégrée.
 */
function pRequireInstaller_(){
 const expected=String(pProperties_().getProperty('INSTALLER_EMAIL')||'').trim().toLowerCase();
 const email=String(Session.getActiveUser().getEmail()||'').trim().toLowerCase();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expected)||!email||email!==expected)throw Error('Définissez INSTALLER_EMAIL et exécutez cette fonction avec ce compte dans l’éditeur Apps Script.');
 return {id:'INSTALLER',email};
}
function pInitialDirector_(){
 const p=pProperties_(),email=String(p.getProperty('INITIAL_DIRECTOR_EMAIL')||'').trim().toLowerCase(),name=String(p.getProperty('INITIAL_DIRECTOR_NAME')||'').trim();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.endsWith('.test')||email.endsWith('.invalid')||!name||name.length>100)throw Error('Renseignez INITIAL_DIRECTOR_EMAIL et INITIAL_DIRECTOR_NAME avec votre propre responsable.');
 return {email,name,role:'DIRECTOR',bootstrapKey:'director'};
}
function pEnsureTable_(book,name,headers){
 let sheet=book.getSheetByName(name);
 if(!sheet)sheet=book.insertSheet(name);
 const width=sheet.getLastColumn();
 if(width){
  const actual=sheet.getRange(1,1,1,width).getValues()[0];
  if(JSON.stringify(actual)!==JSON.stringify(headers))throw Error('Colonnes incompatibles : '+name+'. Aucune donnée existante n’a été écrasée.');
  return;
 }
 sheet.getRange(1,1,1,headers.length).setValues([headers]).setFontWeight('bold');
 sheet.setFrozenRows(1);
}
function pConfiguredBook_(key,title){
 const props=pProperties_();let id=props.getProperty(key);
 if(!id){const book=SpreadsheetApp.create(title);id=book.getId();props.setProperty(key,id);return book;}
 return SpreadsheetApp.openById(id);
}
function pEnsureSourceBooks_(){
 const p=pProperties_();
 const configured=['TV_BOOK_ID','ADMIN_BOOK_ID','PORTAL_BOOK_ID'].map(k=>p.getProperty(k)).filter(Boolean);
 if(new Set(configured).size!==configured.length)throw Error('Les trois classeurs doivent être distincts.');
 const tv=pConfiguredBook_('TV_BOOK_ID','AtoutSport — Planning et affichage');
 const admin=pConfiguredBook_('ADMIN_BOOK_ID','AtoutSport — Administration privée');
 for(const [name,headers] of Object.entries(P_PUBLIC_TV_TABLES_))pEnsureTable_(tv,name,headers);
 for(const [name,headers] of Object.entries({...P_PUBLIC_PRIVATE_TABLES_,...P_PUBLIC_SPORT_TABLES_}))pEnsureTable_(admin,name,headers);
 for(const [key,title] of [['MEDIA_FOLDER_ID','AtoutSport — Médias affichage'],['PHOTO_FOLDER_ID','AtoutSport — Photos affichage'],['PORTAL_FOLDER_ID','AtoutSport — Documents privés']]){
  if(!p.getProperty(key))p.setProperty(key,DriveApp.createFolder(title).getId());
 }
 return {tv,admin};
}
function INSTALL_PORTAL_(){
 const actor=pRequireInstaller_(),director=pInitialDirector_();
 return pWithLock_(()=>{
  const props=pProperties_();
  // Installation et préparation des invitations n'envoient aucun message.
  if(!props.getProperty('APP_EMAIL_ENABLED'))props.setProperty('APP_EMAIL_ENABLED','false');
  const sources=pEnsureSourceBooks_();
  const book=pConfiguredBook_('PORTAL_BOOK_ID','AtoutSport — Portail privé');
  if([sources.tv.getId(),sources.admin.getId()].includes(book.getId()))throw Error('Le portail exige un classeur distinct.');
  for(const table of P_TABLES_)pEnsureTable_(book,table,['ID','JSON']);
  SpreadsheetApp.flush();
  const users=pRows_('USERS');
  if(!users.length){
   const user={...director,id:pId_(),monitorId:'',active:true,deleted:false,uid:'',revision:1,createdAt:pNow_()};
   pCommit_([{table:'USERS',record:user}],actor,'INSTALLER_DIRECTION');
   props.setProperty('DIRECTOR_NOTIFICATION_USER_ID',user.id);
  }
  props.setProperty('PORTAL_INITIAL_ACCOUNTS_SEEDED','true');
  return {portal:book.getUrl(),administration:sources.admin.getUrl(),planning:sources.tv.getUrl(),users:pRows_('USERS').length,notificationsEnabled:props.getProperty('APP_EMAIL_ENABLED')==='true'};
 });
}

const P_PUBLIC_TV_TABLES_ = {
  "SLIDES": [
    "SlideID",
    "Titre",
    "ModeCreation",
    "Image",
    "Template",
    "Message",
    "DateDebut",
    "DateFin",
    "HeureDebut",
    "HeureFin",
    "JoursDeLaSemaine",
    "DureeSecondes",
    "Priorite",
    "Frequence",
    "Ordre",
    "ModeAdaptation",
    "Statut",
    "Active",
    "DerniereModification"
  ],
  "HORAIRES": [
    "HoraireID",
    "MoniteurID",
    "JourSemaine",
    "HeureDebut",
    "HeureFin",
    "DateDebut",
    "DateFin",
    "Actif",
    "Commentaire"
  ],
  "EXCEPTIONS": [
    "ExceptionID",
    "Date",
    "MoniteurID",
    "Type",
    "RemplacantID",
    "HeureDebut",
    "HeureFin",
    "Active",
    "Commentaire"
  ],
  "PRESENCES": [
    "PresenceID",
    "Date",
    "MoniteurID",
    "HeureDebut",
    "HeureFin",
    "Present",
    "Commentaire"
  ],
  "MONITEURS": [
    "MoniteurID",
    "Prenom",
    "Nom",
    "NomAffiche",
    "Fonction",
    "Photo",
    "DateNaissance",
    "Ordre",
    "Actif"
  ],
  "ANNIVERSAIRES": [
    "AnniversaireID",
    "Prenom",
    "Nom",
    "DateNaissance",
    "Photo",
    "Message",
    "Active"
  ],
  "URGENCES": [
    "UrgenceID",
    "Titre",
    "Message",
    "DateDebut",
    "DateFin",
    "DureeSecondes",
    "Frequence",
    "Couleur",
    "Active"
  ],
  "PARAMETRES": [
    "Cle",
    "Valeur"
  ]
};
const P_PUBLIC_PRIVATE_TABLES_ = {
  REMUNERATIONS:['FicheID','MoniteurID','Mois','Statut','Activite','PrixHeure','RetenuePct','ChargePct','CotisationsValidees'],
  AJUSTEMENTS:['CorrectionID','MoniteurID','Date','Minutes','Motif','Active'],
  PAIEMENTS:['PaiementID','MoniteurID','Mois','Date','Montant','Mode','Reference','Note','Active'],
  DOCUMENTS:['DocumentID','MoniteurID','Titre','Type','FichierID','DateDocument','DateFin','Active','CreeLe'],
  CLOTURES:['ClotureID','MoniteurID','Mois','DonneesJSON','SourceRevision','ValideLe','ValidePar','Active','ReouvertureMotif'],
  ARCHIVES:['ArchiveID','TableSource','CleSource','DonneesJSON','ArchiveLe','ArchivePar','Active'],
  PAYROLL_PREFERENCES:['MoniteurID','Standby','ModifieLe','ModifiePar'],
  CONTRACT_DRAFTS:['MoniteurID','DonneesJSON','ModifieLe','ModifiePar'],
  JOURNAL:['EvenementID','Date','Compte','Action','Table','ElementID','AvantJSON','ApresJSON']
};
const P_PUBLIC_SPORT_TABLES_ = {
 EQUIPE_EXTRA:['MoniteurID','Role','Statut','Activites','Nom','Prenom','DateNaissance','Photo','Email','Telephone','Actif','ModifieLe','Adresse'],
 SEANCES:['SeanceID','Secteur','Activite','Titre','Date','HeureDebut','HeureFin','MoniteurID','Lieu','Capacite','Active','Note'],
 ENFANTS:['EnfantID','Nom','Prenom','DateNaissance','Responsable','Contact','Actif'],
 INSCRIPTIONS:['InscriptionID','SeanceID','EnfantID','Statut','Note','Active'],
 SUIVI_MENSUEL:['SuiviID','MoniteurID','Mois','StatutFiche','DateLimite','DateReception','DocumentID','Note']
};

function PREPARER_INVITATIONS_(){
 const actor=pRequireInstaller_();if(!getPortalConfig().configured)throw Error('Renseignez d’abord la configuration Firebase.');
 return pWithLock_(()=>{
  let prepared=0;for(const u of pRows_('USERS').filter(u=>u.active&&!u.deleted&&!u.uid)){
   if(u.inviteHash&&new Date(u.inviteExpiresAt)>new Date())continue;
   const invitation=pInvitation_({...u,revision:u.revision+1});pCommit_(invitation.changes,actor,'PREPARER_INVITATION');prepared++;
  }return {prepared,emailsSent:0};
 });
}
function ACTIVER_NOTIFICATIONS_(){
 pRequireInstaller_();if(!getPortalConfig().configured||!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(pProperties_().getProperty('APP_URL')||''))throw Error('Terminez la configuration du portail.');
 return pWithLock_(()=>{
  const triggers=ScriptApp.getProjectTriggers();
  for(const name of ['pDeliverMail_','pPrepareReminders_']){
   const own=triggers.filter(t=>t.getHandlerFunction()===name);
   for(const duplicate of own.slice(1))ScriptApp.deleteTrigger(duplicate);
   if(!own.length){
    const timer=ScriptApp.newTrigger(name).timeBased();
    if(name==='pDeliverMail_')timer.everyMinutes(5).create();
    else timer.atHour(9).everyDays(1).inTimezone('Europe/Brussels').create();
   }
  }
  pProperties_().setProperty('APP_EMAIL_ENABLED','true');return {enabled:true,deliveryEveryMinutes:5,remindersDailyHour:9,timezone:'Europe/Brussels'};
 });
}
function DESACTIVER_NOTIFICATIONS_(){
 pRequireInstaller_();return pWithLock_(()=>{
  pProperties_().setProperty('APP_EMAIL_ENABLED','false');
  const triggers=ScriptApp.getProjectTriggers().filter(t=>['pDeliverMail_','pPrepareReminders_'].includes(t.getHandlerFunction()));
  for(const trigger of triggers)ScriptApp.deleteTrigger(trigger);
  return {enabled:false,removedTriggers:triggers.length};
 });
}
