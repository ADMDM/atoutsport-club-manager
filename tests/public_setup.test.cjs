const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../apps-script/Setup.gs'),'utf8');
const clone=v=>JSON.parse(JSON.stringify(v));
function harness(extra={}){
 const props={INSTALLER_EMAIL:'owner@example.org',INITIAL_DIRECTOR_EMAIL:'director@example.org',INITIAL_DIRECTOR_NAME:'Direction exemple',...extra};
 const users=[],books={},created=[],writes=[];let n=0;
 const property={getProperty:k=>props[k]||null,setProperty(k,v){props[k]=v;return this}};
 function book(id){return books[id]||(books[id]={getId:()=>id,getUrl:()=> 'https://example.test/'+id,sheets:{},getSheetByName(name){return this.sheets[name]||null},insertSheet(name){const sh={headers:[],getLastColumn:()=>sh.headers.length,setFrozenRows(){},getRange(){return {getValues:()=>[clone(sh.headers)],setValues(v){sh.headers=clone(v[0]);writes.push([id,name,clone(v[0])]);return this},setFontWeight(){return this}}}};this.sheets[name]=sh;return sh}})}
 const c={JSON,Set,Object,String,Error,console,pProperties_:()=>property,Session:{getActiveUser:()=>({getEmail:()=>c.email})},email:'owner@example.org',pWithLock_:fn=>fn(),P_TABLES_:['USERS','TIMESHEETS','RECOVERIES','DOCUMENTS','OUTBOX','AUDIT','HISTORY','IDENTITY'],pRows_:()=>clone(users),pId_:()=> 'u'+ ++n,pNow_:()=> '2026-11-25T00:00:00Z',pCommit_:changes=>changes.forEach(x=>users.push(clone(x.record))),SpreadsheetApp:{create(title){const id='book-'+ ++n;created.push(title);return book(id)},openById:book,flush(){}},DriveApp:{createFolder(title){created.push(title);return {getId:()=> 'folder-'+ ++n}}}};
 vm.createContext(c);vm.runInContext(source,c);return {c,props,users,books,created,writes,book};
}
test('installation: propriétaire explicite requis avant toute création',()=>{
 for(const properties of [{INSTALLER_EMAIL:''},{INITIAL_DIRECTOR_EMAIL:'demo@example.test'},{INITIAL_DIRECTOR_NAME:''}]){const h=harness(properties);assert.throws(()=>h.c.INSTALL_PORTAL_());assert.equal(h.created.length,0)}
 const h=harness();h.c.email='someone@example.org';assert.throws(()=>h.c.INSTALL_PORTAL_());assert.equal(h.created.length,0);
});
test('installation: trois classeurs séparés, tables métier, dossiers et une direction sans envoi',()=>{
 const h=harness(),result=h.c.INSTALL_PORTAL_();
 assert.equal(new Set(['TV_BOOK_ID','ADMIN_BOOK_ID','PORTAL_BOOK_ID'].map(k=>h.props[k])).size,3);
 assert.equal(h.users.length,1);assert.equal(h.users[0].role,'DIRECTOR');assert.equal(h.users[0].uid,'');
 assert.equal(h.props.DIRECTOR_NOTIFICATION_USER_ID,h.users[0].id);assert.equal(h.props.APP_EMAIL_ENABLED,'false');assert.equal(result.notificationsEnabled,false);
 assert.ok(h.books[h.props.TV_BOOK_ID].sheets.SLIDES);assert.ok(h.books[h.props.ADMIN_BOOK_ID].sheets.EQUIPE_EXTRA);assert.ok(h.books[h.props.ADMIN_BOOK_ID].sheets.CLOTURES);assert.ok(h.books[h.props.PORTAL_BOOK_ID].sheets.HISTORY);
});
test('installation répétée: aucun doublon de compte, tableau ou dossier',()=>{
 const h=harness();h.c.INSTALL_PORTAL_();const before={created:h.created.length,writes:h.writes.length,users:clone(h.users)};h.c.INSTALL_PORTAL_();
 assert.equal(h.created.length,before.created);assert.equal(h.writes.length,before.writes);assert.deepEqual(h.users,before.users);
});
test('installation: ressources identiques et en-têtes existants incompatibles refusés',()=>{
 const h=harness({TV_BOOK_ID:'same',ADMIN_BOOK_ID:'same'});assert.throws(()=>h.c.INSTALL_PORTAL_(),/distincts/);assert.equal(h.created.length,0);
 const x=harness({TV_BOOK_ID:'existing'});x.book('existing').insertSheet('SLIDES').headers=['AncienneColonne'];assert.throws(()=>x.c.INSTALL_PORTAL_(),/Colonnes incompatibles/);assert.deepEqual(x.book('existing').sheets.SLIDES.headers,['AncienneColonne']);
});
test('édition publique: aucune signature par défaut et maintenance exclue du serveur',()=>{
 const code=fs.readFileSync(path.join(__dirname,'../deploy/Code.gs'),'utf8');
 assert.match(code,/function employerSignature_\(\)\{return '';\}/);assert.doesNotMatch(code,/function runInstallPortal\(/);
 const entry=[...code.matchAll(/^function (\w+)\(/gm)].map(x=>x[1]).filter(x=>!x.endsWith('_')).sort();assert.deepEqual(entry,['doGet','getPortalConfig','portalRpc']);
});
