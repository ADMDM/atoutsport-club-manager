const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
// Réutilise les environnements Google simulés des tests existants sans les réexécuter.
exports.fixture=(file,exports)=>{
 const source=fs.readFileSync(path.join(__dirname,file),'utf8').split('\ntest(')[0];
 const context={require,console,__dirname,Buffer};vm.createContext(context);
 vm.runInContext(source+'\nthis.fixtureExports={'+exports+'};',context);
 return context.fixtureExports;
};
