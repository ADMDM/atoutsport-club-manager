const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../apps-script/AdminHelp.html'),'utf8');
const script=source.match(/<script>([\s\S]*)<\/script>/)[1];
function element(tag='BUTTON',options={}){
 const attrs=options.attrs||{},ancestors=options.ancestors||{};
 return {tagName:tag,textContent:options.text||'',title:options.title||'',id:options.id||'',name:options.name||'',type:options.type||'',required:!!options.required,disabled:!!options.disabled,dataset:options.dataset||{},isConnected:options.connected!==false,labels:[],classList:{contains:n=>(options.classes||[]).includes(n)},getAttribute:n=>attrs[n]??null,hasAttribute:n=>n in attrs,closest:s=>ancestors[s]||null,getClientRects:()=>options.hidden?[]:[{}],matches:s=>s.split(',').some(x=>x.toLowerCase()===tag.toLowerCase()),querySelector:s=>options.queries?.[s]||null,querySelectorAll:()=>options.children||[],append(){},addEventListener(){},setAttribute(){}};
}
function harness(){
 const help=element('DIALOG');
 const document={createElement:t=>element(t.toUpperCase()),body:element('BODY'),querySelectorAll:()=>[],getElementById:id=>id==='help'?help:null,addEventListener(){}};
 const context=vm.createContext({document,window:{addEventListener(){}},MutationObserver:class{observe(){}},getComputedStyle:()=>({visibility:'visible'}),table:'PAYROLL',editTable:'',dossierSection:'FINANCE',DAYS:['Lundi'],rpc(){throw Error('RPC interdit pendant une explication')},api(){throw Error('RPC interdit pendant une explication')}});
 vm.runInContext(script,context);return {api:vm.runInContext('AdminHelp',context),context};
}
test('aide : tous les scripts livrés se compilent, y compris le module intégré',()=>{
 for(const name of ['apps-script/AdminHelp.html','deploy/Legacy.html']){
  const text=fs.readFileSync(path.join(__dirname,'..',name),'utf8');
  for(const [,s]of text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(s);
  assert.match(text,/const AdminHelp =/);
 }
});
test('aide : chaque vue administrative a des instructions et un objectif',()=>{
 const {api,context}=harness();for(const key of ['MONITEURS','TEAM_EXTRA','DOSSIER','HORAIRES','EXCEPTIONS','PRESENCES','ARCHIVES','PAYROLL','PAIEMENTS','AJUSTEMENTS','REMUNERATIONS','CONTRACTS','DOCUMENTS','SUIVI','SEANCES','ENFANTS','INSCRIPTIONS','SLIDES','URGENCES','ANNIVERSAIRES','PARAMETRES']){
  context.table=key;const c=api.context(element('MAIN'));assert.ok(c.description.length>40,key);assert.ok(c.steps.length>=2,key);
 }
});
test('aide : les quatre rubriques du dossier sont distinguées',()=>{
 const {api,context}=harness();context.table='DOSSIER';const titles=new Set();for(const section of ['PROFILE','PLANNING','FINANCE','DOCUMENTS']){context.dossierSection=section;titles.add(api.context(element('MAIN')).title);}assert.equal(titles.size,4);
});
test('aide : un formulaire de tarif ouvert depuis un dossier explique le tarif mensuel',()=>{
 const {api,context}=harness();context.table='DOSSIER';const root=element('DIALOG',{queries:{'[name="PrixHeure"]':element('INPUT')}});const c=api.context(root);assert.equal(c.key,'REMUNERATIONS');assert.equal(c.isForm,true);assert.match(c.description,/distincts du tarif/);
});
test('aide : contrats et documents ouverts depuis un dossier ont le bon contexte',()=>{
 const {api,context}=harness();context.table='DOSSIER';assert.equal(api.context(element('DIALOG',{queries:{h2:{textContent:'Ajouter un document'}}})).key,'DOCUMENTS');assert.equal(api.context(element('DIALOG',{queries:{h2:{textContent:'Préparer un contrat'}}})).key,'CONTRACTS');
});
test('aide : conserver la distinction versement enregistré et virement bancaire',()=>{
 const {api}=harness();const result=api.explain(element('BUTTON',{text:'Enregistrer un versement'}),{key:'PAYROLL'});assert.match(result.description,/déjà réalisé/);assert.match(result.description,/Aucun virement/);
});
test('aide : noter un contrat envoyé ne prétend pas envoyer un e-mail',()=>{
 const {api}=harness();assert.match(api.explain(element('BUTTON',{text:'Noter comme envoyé'}),{key:'CONTRACTS'}).description,/n’envoie pas d’e-mail/);
});
test('aide : annuler une écriture et annuler un formulaire sont distingués',()=>{
 const {api}=harness(),n=element('BUTTON',{text:'Annuler'});assert.match(api.explain(n,{key:'PAIEMENTS',isForm:false}).description,/écriture de paiement/);assert.match(api.explain(n,{key:'PAIEMENTS',isForm:true}).description,/saisie/);
});
test('aide : Retirer une image ne promet pas de retirer un horaire',()=>{
 const {api}=harness();const e=api.explain(element('BUTTON',{text:'Retirer',ancestors:{'#uploadSummary':{}}}),{key:'SLIDES',isForm:true});assert.match(e.description,/fichier sélectionné/);assert.match(e.description,/Aucun horaire/);
});
test('aide : éléments masqués exclus et actions répétées regroupées',()=>{
 const {api}=harness(),root=element('MAIN',{children:[element('BUTTON',{text:'Modifier'}),element('BUTTON',{text:'Modifier'}),element('BUTTON',{text:'Archiver',hidden:true}),element('BUTTON',{text:'Aide',dataset:{adminHelp:''}})]});assert.equal(api.entries(root,{key:'DOCUMENTS'}).length,1);
});
test('aide : droits conservés et raison de désactivation fournie',()=>{
 const {api}=harness(),n=element('BUTTON',{text:'Clôturer le mois',disabled:true,title:'Validation réservée à la direction'}),root=element('MAIN',{children:[n]});const e=api.entries(root,{key:'PAYROLL'})[0];assert.equal(e.disabled,true);assert.equal(e.reason,n.title);assert.equal(n.disabled,true);assert.match(e.description,/direction/);
});
test('aide : le tarif et les cotisations sont expliqués sans lire les valeurs personnelles',()=>{
 const {api}=harness(),n=element('INPUT',{name:'PrixHeure',required:true});Object.defineProperty(n,'value',{get(){throw Error('Lecture de valeur personnelle interdite')}});const e=api.explain(n,{key:'REMUNERATIONS',isForm:true});assert.match(e.description,/ne modifie pas le tarif d’un contrat/);assert.match(e.description,/obligatoire/);
});
test('aide : les boutons sans texte utilisent leur libellé accessible',()=>{
 const {api}=harness();assert.match(api.explain(element('BUTTON',{attrs:{'aria-label':'Actualiser les données'}}),{key:'PAYROLL'}).description,/Recharge/);assert.match(api.explain(element('BUTTON',{attrs:{'aria-label':'Monter Une slide'}}),{key:'SLIDES'}).description,/ordre de diffusion/);
});
