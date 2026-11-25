/* Outil temporaire pour l'éditeur : ne jamais inclure dans une version Web.
 * Ajouter à HEAD pour exécuter une commande, puis retirer avant déploiement.
 */
function runInstallPortal(){pRequireInstaller_();console.log(JSON.stringify(INSTALL_PORTAL_()));}
function runPrepareInvitations(){pRequireInstaller_();console.log(JSON.stringify(PREPARER_INVITATIONS_()));}
function runEnableMail(){pRequireInstaller_();console.log(JSON.stringify(ACTIVER_NOTIFICATIONS_()));}
function runDisableMail(){pRequireInstaller_();console.log(JSON.stringify(DESACTIVER_NOTIFICATIONS_()));}
function runDeliverMail(){pRequireInstaller_();console.log(JSON.stringify(pDeliverMail_()));}
function runCheckInstall(){
 pRequireInstaller_();return pWithLock_(()=>{
  const users=pRows_('USERS'),out=pRows_('OUTBOX');
  const result={configured:getPortalConfig().configured,users:users.length,activated:users.filter(u=>u.uid&&u.active&&!u.deleted).length,notificationsEnabled:pProperties_().getProperty('APP_EMAIL_ENABLED')==='true',pendingMail:out.filter(m=>m.status==='PENDING').length};
  console.log(JSON.stringify(result));return result;
 });
}
