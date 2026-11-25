const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../apps-script/DirectorCorrectionUi.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
function harness(role='DIRECTOR',status='SUBMITTED'){
  let observer,dialog,confirm=true,removed=false;
  const calls=[],events={},nodes={};
  class Element{
    constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.events={};this.value='';this.textContent='';this.disabled=false;}
    append(...children){this.children.push(...children)}
    prepend(child){this.children.unshift(child)}
    setAttribute(){}
    addEventListener(name,fn){this.events[name]=fn}
    querySelector(s){return nodes[s]||null}
    querySelectorAll(){return []}
    focus(){this.focused=true}
    showModal(){this.open=true}
    close(){this.open=false;this.events.close?.()}
    remove(){removed=true}
    set innerHTML(v){this.markup=v}
    get innerHTML(){return this.markup}
  }
  const info=new Element('p');info.textContent='La déclaration reste attribuée au moniteur. Chaque décision est conservée dans l’historique.';
  const heading={textContent:'Contrôle de la fiche'},buttons=new Element('div');
  const panel=new Element('section');panel.querySelector=s=>s==='h2'?heading:s==='.buttons'?buttons:s==='[data-director-correct]'?buttons.children.find(x=>x.dataset.directorCorrect):null;panel.querySelectorAll=s=>s==='p'?[info]:[];
  const main=new Element('main');main.querySelectorAll=s=>s==='section'?[panel]:[];main.querySelector=s=>main.children.find(x=>x.dataset.directorCorrectionNotice)||null;
  for(const id of ['form','#dcLines','#dcAdd','#dcDeclaration','#dcReason','#dcError','#dcCancel'])nodes[id]=new Element(id);
  nodes.form.querySelectorAll=()=>[nodes['#dcReason'],nodes['#dcCancel']];
  const body=new Element('body');body.append=d=>{dialog=d};
  const c={console,structuredClone,crypto:require('node:crypto').webcrypto,Date,document:{getElementById:id=>id==='main'?main:null,createElement:tag=>new Element(tag),body},
    MutationObserver:class{constructor(fn){observer=fn}observe(){}},
    window:{confirm:()=>confirm,addEventListener:(name,fn)=>events[name]=fn,removeEventListener:name=>delete events[name]},
    page:'hours',actor:{id:'jl',name:'la direction',role},busy:false,dirty:false,people:[{id:'M1',name:'Camille'},{id:'M2',name:'Alex'}],
    monthData:{exists:true,activities:['Natation'],sheet:{id:'M1__2026-10',monitorId:'M1',month:'2026-10',revision:2,status,lines:[{id:'one',date:'2026-10-03',start:'10:00',end:'11:00',type:'NORMAL',activity:'Natation',note:'<img src=x onerror=alert(1)>'}],declarationNote:''}},
    lines:[],declarationNote:'',monitorName:()=> 'Camille <test>',confirmLeave:()=>confirm,
    renderMonth:()=>calls.push('render'),notify:message=>calls.push(message),
    setBusyState:value=>c.busy=value,
  };
  c.api=async(action,payload)=>{calls.push({action,payload});return {...c.monthData,sheet:{...c.monthData.sheet,revision:3,lines:payload.lines}}};
  vm.createContext(c);vm.runInContext(script,c);
  return {c,main,info,buttons,nodes,events,calls,observe:()=>observer(),get dialog(){return dialog},get removed(){return removed},set confirm(value){confirm=value}};
}
test('l’interface offre les deux choix uniquement à la direction et sans bouton dupliqué',()=>{
  const h=harness();assert.match(h.info.textContent,/demander une correction.*corriger vous-même/);assert.equal(h.buttons.children[0].textContent,'Corriger moi-même');
  h.observe();assert.equal(h.buttons.children.length,1);
  for(const role of ['MONITOR','MANAGER','SECRETARY','TECHNICAL'])assert.equal(harness(role).buttons.children.length,0);
  assert.equal(harness('DIRECTOR','APPROVED').buttons.children.length,0);
});
test('ouvrir ne modifie pas la fiche et les textes restent échappés',()=>{
  const h=harness(),before=structuredClone(h.c.monthData);h.buttons.children[0].onclick();
  assert.equal(h.dialog.open,true);assert.deepEqual(h.c.monthData,before);assert.match(h.dialog.innerHTML,/Camille &lt;test&gt;/);
  assert.match(h.nodes['#dcLines'].innerHTML,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.doesNotMatch(h.nodes['#dcLines'].innerHTML,/<img/);
  assert.match(html,/\[hidden\]\{display:none!important\}/);
});
test('la sauvegarde exige un motif et transmet explicitement une correction de direction',async()=>{
  const h=harness();h.buttons.children[0].onclick();const submit=h.nodes.form.onsubmit;
  await submit({preventDefault(){}});assert.match(h.nodes['#dcError'].textContent,/motif/);assert.equal(h.calls.length,0);
  h.nodes['#dcReason'].value='Horaire vérifié';await submit({preventDefault(){}});
  const call=h.calls.find(x=>x.action);assert.equal(call.action,'review');assert.equal(call.payload.decision,'CORRECT');assert.equal(call.payload.revision,2);assert.equal(call.payload.comment,'Horaire vérifié');
  assert.equal(h.c.monthData.sheet.revision,3);assert.equal(h.c.busy,false);assert.equal(h.removed,true);assert.equal(h.events.beforeunload,undefined);
});
test('un double clic ne produit qu’une requête et une erreur conserve le formulaire',async()=>{
  const h=harness();h.buttons.children[0].onclick();h.nodes['#dcReason'].value='Correction vérifiée';let reject,count=0;
  h.c.api=()=>{count++;return new Promise((resolve,r)=>reject=r)};
  const saving=h.nodes.form.onsubmit({preventDefault(){}});await h.nodes.form.onsubmit({preventDefault(){}});assert.equal(count,1);assert.equal(h.c.busy,true);
  reject(Error('La fiche a changé. Rechargez-la.'));await saving;
  assert.equal(h.dialog.open,true);assert.equal(h.removed,false);assert.equal(h.c.busy,false);assert.match(h.nodes['#dcError'].textContent,/fiche a changé/);assert.equal(h.nodes['#dcReason'].value,'Correction vérifiée');assert.equal(h.nodes['#dcReason'].disabled,false);
});
test('la fermeture et le départ de page protègent une correction non enregistrée',()=>{
  const h=harness();h.buttons.children[0].onclick();h.nodes.form.events.input();h.confirm=false;h.nodes['#dcCancel'].onclick();assert.equal(h.dialog.open,true);
  let prevented=false;h.events.beforeunload({preventDefault(){prevented=true}});assert.equal(prevented,true);
  h.confirm=true;h.nodes['#dcCancel'].onclick();assert.equal(h.removed,true);assert.equal(h.events.beforeunload,undefined);
});
test('le nom, la date et le motif de correction sont visibles sur la fiche du moniteur',()=>{
  const h=harness('MONITOR');h.c.monthData.sheet.directorCorrection={name:'la direction',at:'2026-11-25T20:00:00Z',reason:'Fin du cours corrigée'};h.observe();h.observe();
  assert.equal(h.main.children.length,1);assert.match(h.main.children[0].children[0].textContent,/la direction/);assert.equal(h.main.children[0].children[1].textContent,'Fin du cours corrigée');
});
