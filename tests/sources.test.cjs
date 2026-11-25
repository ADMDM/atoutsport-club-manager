const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const code = fs.readFileSync(path.join(__dirname, '../apps-script/Sources.gs'), 'utf8');
const ctx = vm.createContext({console});
vm.runInContext(code, ctx);
const plain = value => JSON.parse(JSON.stringify(value));
const monitors = [{MoniteurID: 'A'}, {MoniteurID: 'B'}, {MoniteurID: 'C'}];
const shift = (owner, start = '09:00', end = '12:00', extra = {}) => ({HoraireID: owner + '-1', MoniteurID: owner, JourSemaine: 'Lundi', HeureDebut: start, HeureFin: end, Actif: true, ...extra});
const exception = (type, owner = 'A', extra = {}) => ({ExceptionID: type + owner, MoniteurID: owner, Date: '2026-11-02', Type: type, HeureDebut: '09:00', HeureFin: '12:00', Active: true, ...extra});
const expected = (input, owner = 'A', month = '2026-11') => plain(ctx.pExpectedFrom_({monitors, weekly: [shift('A')], ...input}, month, owner));
const onDate = (rows, date = '2026-11-02') => rows.filter(row => row.date === date);

test('un mois compte les occurrences calendaires exactes et les limites de validité inclusives', () => {
  assert.equal(expected({}).length, 5);
  const rows = expected({weekly: [shift('A', '09:00', '12:00', {DateDebut: '2026-11-09', DateFin: '2026-11-23'})]});
  assert.deepEqual(rows.map(row => row.date), ['2026-11-09', '2026-11-16', '2026-11-23']);
});

test('présence datée remplace la journée récurrente et Present=false annule cette journée', () => {
  const cancelled = expected({presences: [{MoniteurID: 'A', Date: '2026-11-02', Present: false, HeureDebut: '09:00', HeureFin: '12:00'}]});
  assert.equal(onDate(cancelled).length, 0);
  const moved = expected({presences: [{PresenceID: 'P1', MoniteurID: 'A', Date: '2026-11-02', Present: true, HeureDebut: '10:00', HeureFin: '11:00'}]});
  assert.deepEqual(onDate(moved).map(row => [row.start, row.end, row.origin]), [['10:00', '11:00', 'PRESENCE:P1']]);
});

test('absence et remplacement donnent le même résultat dans les deux ordres', () => {
  const absence = exception('ABSENCE');
  const replacement = exception('REMPLACEMENT', 'A', {RemplacantID: 'B'});
  const first = expected({exceptions: [absence, replacement]}, 'B');
  const last = expected({exceptions: [replacement, absence]}, 'B');
  assert.deepEqual(first, last);
  assert.deepEqual(onDate(first).map(row => [row.start, row.end, row.replacedMonitorId]), [['09:00', '12:00', 'A']]);
  assert.equal(onDate(expected({exceptions: [absence, replacement]}, 'A')).length, 0);
});

test('une absence partielle découpe les périodes sans inclure la pause', () => {
  const rows = onDate(expected({exceptions: [exception('ABSENCE', 'A', {HeureDebut: '10:00', HeureFin: '10:30'})]}));
  assert.deepEqual(rows.map(row => [row.start, row.end]), [['09:00', '10:00'], ['10:30', '12:00']]);
});

test('MODIFICATION précède toujours absences et transferts', () => {
  const moved = exception('MODIFICATION', 'A', {HeureDebut: '13:00', HeureFin: '15:00'});
  const replaced = exception('REMPLACEMENT', 'A', {RemplacantID: 'B', HeureDebut: '14:00', HeureFin: '15:00'});
  assert.deepEqual(expected({exceptions: [moved, replaced]}, 'B'), expected({exceptions: [replaced, moved]}, 'B'));
  assert.deepEqual(onDate(expected({exceptions: [replaced, moved]}, 'B')).map(row => [row.start, row.end]), [['14:00', '15:00']]);
});

test('plusieurs modifications concurrentes sont refusées', () => {
  assert.throws(() => expected({exceptions: [exception('MODIFICATION'), exception('MODIFICATION', 'A', {ExceptionID: 'M2'})]}), /Plusieurs modifications/);
});

test('deux remplaçants affectés à la même minute sont refusés', () => {
  assert.throws(() => expected({exceptions: [exception('REMPLACEMENT', 'A', {RemplacantID: 'B'}), exception('REMPLACEMENT', 'A', {ExceptionID: 'R2', RemplacantID: 'C'})]}), /Deux remplacements/);
});

test('remplaçant déjà occupé ou absent : erreur explicite', () => {
  const replacement = exception('REMPLACEMENT', 'A', {RemplacantID: 'B'});
  assert.throws(() => expected({weekly: [shift('A'), shift('B')], exceptions: [replacement]}, 'B'), /chevauche/);
  assert.throws(() => expected({exceptions: [replacement, exception('ABSENCE', 'B')]}, 'B'), /à la fois absent/);
});

test('remplacement sans créneau source ou vers un moniteur inconnu refusé', () => {
  assert.throws(() => expected({exceptions: [exception('REMPLACEMENT', 'A', {RemplacantID: 'B', HeureDebut: '13:00', HeureFin: '14:00'})]}), /sans créneau/);
  assert.throws(() => expected({exceptions: [exception('REMPLACEMENT', 'A', {RemplacantID: 'X'})]}), /incorrect/);
});

test('chevauchement récurrent ne produit jamais silencieusement un total dédoublonné', () => {
  assert.throws(() => expected({weekly: [shift('A'), shift('A', '11:00', '13:00')]}), /Chevauchement/);
});

test('plage de nuit hors périmètre et dates impossibles refusées', () => {
  assert.throws(() => expected({weekly: [shift('A', '23:00', '01:00')]}), /même jour/);
  assert.throws(() => expected({}, 'A', '2026-13'), /Mois/);
  assert.throws(() => expected({exceptions: [exception('ABSENCE', 'A', {Date: '2026-02-30'})]}), /Date incorrecte/);
});

test('année bissextile et valeurs horaires Sheets restent exactes', () => {
  const rows = expected({weekly: [shift('A', 9 / 24, 12 / 24, {JourSemaine: 'Mardi'})]}, 'A', '2028-02');
  assert.equal(rows.length, 5);
  assert.equal(rows.at(-1).date, '2028-02-29');
  assert.equal(rows[0].start, '09:00');
});

test('finances : aucun taux inventé et paiements uniquement actifs du mois concerné', () => {
  const source = plain(ctx.pFinanceFrom_({payments: [
    {MoniteurID: 'A', Mois: '2026-11', Montant: '10,25', Active: true},
    {MoniteurID: 'A', Mois: '2026-11', Montant: 100, Active: false},
    {MoniteurID: 'A', Mois: '2026-10', Montant: 50, Active: true},
    {MoniteurID: 'B', Mois: '2026-11', Montant: 50, Active: true}
  ]}, '2026-11', 'A'));
  assert.equal(source.rate, null);
  assert.equal(source.deductionPct, null);
  assert.equal(source.contributionsConfirmed, false);
  assert.equal(source.paidCents, 1025);
  assert.equal(source.warnings.length, 2);
});

test('finances : corrections existantes signalées sans ajout automatique au travail déclaré', () => {
  const result = plain(ctx.pFinanceFrom_({
    rates: [{MoniteurID: 'A', Mois: '2026-11', PrixHeure: '15,50', RetenuePct: 0, ChargePct: '5,42', CotisationsValidees: true}],
    adjustments: [{MoniteurID: 'A', Date: '2026-11-02', Minutes: 60, Active: true}, {MoniteurID: 'A', Date: '2026-11-09', Minutes: -15, Active: true}]
  }, '2026-11', 'A'));
  assert.equal(result.rate, 15.5);
  assert.equal(result.chargePct, 5.42);
  assert.equal(result.adjustmentsMinutes, 45);
  assert.equal(result.adjustmentsCount, 2);
  assert.match(result.warnings[0], /pas ajoutées/);
});

test('finances : profils multiples, taux confirmés manquants et fractions de minute refusés', () => {
  const row = {MoniteurID: 'A', Mois: '2026-11', PrixHeure: 15, CotisationsValidees: true};
  assert.throws(() => ctx.pFinanceFrom_({rates: [row, row]}, '2026-11', 'A'), /Plusieurs tarifs/);
  assert.throws(() => ctx.pFinanceFrom_({rates: [row]}, '2026-11', 'A'), /Retenue/);
  assert.throws(() => ctx.pFinanceFrom_({adjustments: [{MoniteurID: 'A', Date: '2026-11-02', Minutes: 1.5, Active: true}]}, '2026-11', 'A'), /minutes entières/);
});

test('adaptateur limité aux tables déclarées, sans aucune écriture Google', () => {
  const reads = [];
  const tables = {MONITEURS: [['MoniteurID', 'Nom', 'Prenom', 'Actif', 'Fonction', 'Email'], ['A', 'Exemple', 'Alice', true, 'Moniteur', 'private@example.test'], ['S', 'Stage', 'Sam', true, 'MONITEUR_STAGE', 'stage@example.test']]};
  const context = vm.createContext({
    PropertiesService: {getScriptProperties: () => ({getProperty: name => name === 'TV_BOOK_ID' ? 'tv-source' : null})},
    SpreadsheetApp: {openById: id => { reads.push(id); return {getSheetByName: name => ({getLastRow: () => tables[name].length, getLastColumn: () => tables[name][0].length, getRange: () => ({getValues: () => tables[name].map(row => [...row])})})}; }}
  });
  vm.runInContext(code, context);
  assert.deepEqual(plain(context.pTeam_()), [{id: 'A', name: 'Alice Exemple', active: true}]);
  assert.deepEqual(reads, ['tv-source']);
  assert.ok(!/\.setValues\(|\.appendRow\(|\.setValue\(|\.clearContent\(/.test(code));
});

function peopleSource(overrides={}) {
 const reads=[];
 const tables={
  MONITEURS:[['MoniteurID','Nom','Prenom','Actif','Fonction','Email','NISS'],['P','Piscine','Paul',true,'Moniteur','pool-private@example.test','PRIVATE-POOL'],['S','Stage','Sam',true,'MONITEUR_STAGE','','']],
  EQUIPE_EXTRA:[['MoniteurID','Nom','Prenom','Actif','Role','Activites','Email','Adresse','NISS','Statut'],['P','','',true,'MONITEUR','Danse','private@example.test','Adresse privée','PRIVATE-ID','ETUDIANT'],['D','Danse','Dana',true,'EXTRASPORT','Danse','dance@example.test','Adresse danse','PRIVATE-DANCE','ART17'],['I','Inactive','Inès',false,'EXTRASPORT','Psychomotricité','','','','']],
  HORAIRES:[['MoniteurID','JourSemaine','HeureDebut','HeureFin','Actif'],['P','Lundi','08:30','13:00',true]],
  PRESENCES:[['MoniteurID','Date','HeureDebut','HeureFin','Present']],
  EXCEPTIONS:[['MoniteurID','Date','Type','HeureDebut','HeureFin','RemplacantID','Active']],
  REMUNERATIONS:[['MoniteurID','Mois','PrixHeure','RetenuePct','ChargePct','CotisationsValidees'],['D','2026-11',18,0,0,true]],
  PAIEMENTS:[['MoniteurID','Mois','Montant','Active']],AJUSTEMENTS:[['MoniteurID','Date','Minutes','Active']],...overrides
 };
 const c=vm.createContext({PropertiesService:{getScriptProperties:()=>({getProperty:key=>({TV_BOOK_ID:'tv',ADMIN_BOOK_ID:'admin'})[key]})},SpreadsheetApp:{openById:id=>({getSheetByName:name=>{reads.push([id,name]);const rows=tables[name];if(!rows)throw Error('Table imprévue '+name);return {getLastRow:()=>rows.length,getLastColumn:()=>rows[0].length,getRange:()=>({getValues:()=>rows.map(r=>[...r])})}}})}});
 vm.runInContext(code,c);return {c,reads};
}
test('équipe canonique sans doublon ni données privées, piscine strictement inchangée',()=>{
 const {c}=peopleSource(),people=plain(c.pPeople_()),pool=plain(c.pTeam_());
 assert.equal(people.length,4);assert.equal(people.filter(p=>p.id==='P').length,1);
 assert.deepEqual(pool,[{id:'P',name:'Paul Piscine',active:true}]);
 assert.equal(people.find(p=>p.id==='P').sourceMode,'POOL');assert.equal(people.find(p=>p.id==='D').sourceMode,'MANUAL');assert.equal(people.find(p=>p.id==='S').sourceMode,'MANUAL');
 assert.deepEqual(people.find(p=>p.id==='S').sectors,['STAGE']);
 for(const rows of [people,plain(c.pPeopleRows_())]){const text=JSON.stringify(rows);assert.doesNotMatch(text,/Email|Adresse|NISS|Statut|PRIVATE-|@|ETUDIANT|ART17/);}
 assert.deepEqual(plain(c.pTeam_()),pool);
});
test('personne manuelle active : aucune heure prévue inventée, aucune table horaire lue',()=>{
 const {c,reads}=peopleSource();assert.deepEqual(plain(c.pExpected_('2026-11','D')),[]);
 assert.ok(!reads.some(([,name])=>['HORAIRES','PRESENCES','EXCEPTIONS'].includes(name)));
 assert.throws(()=>c.pExpected_('2026-11','I'),/inactive/);assert.throws(()=>c.pExpected_('2026-11','UNKNOWN'),/introuvable/);
});
test('identité extra ne modifie aucune durée piscine ; tarif extra lu sans valeur inventée',()=>{
 const {c}=peopleSource(),expectedRows=plain(c.pExpected_('2026-11','P'));assert.equal(expectedRows.length,5);assert.ok(expectedRows.every(r=>r.start==='08:30'&&r.end==='13:00'));
 c.pPeople_();assert.deepEqual(plain(c.pExpected_('2026-11','P')),expectedRows);
 const finance=plain(c.pFinanceSource_('2026-11','D'));assert.equal(finance.rate,18);assert.equal(finance.paidCents,0);
});
test('doublon extra ou source manquante arrête la liste sans fusion ambiguë',()=>{
 const duplicate=[['MoniteurID','Nom','Prenom','Actif'],['D','Danse','Dana',true],['D','Autre','Dana',true]];
 const {c}=peopleSource({EQUIPE_EXTRA:duplicate});assert.throws(()=>c.pPeople_(),/double/);
});
