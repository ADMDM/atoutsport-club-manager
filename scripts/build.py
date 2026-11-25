#!/usr/bin/env python3
"""Assemble les fichiers Apps Script sans accès réseau ni données privées."""
from pathlib import Path
import json,subprocess,hashlib
ROOT=Path(__file__).resolve().parents[1]
source=ROOT/'apps-script';out=ROOT/'deploy';out.mkdir(exist_ok=True)
order=json.loads((ROOT/'scripts/modules.json').read_text())
code='\n\n'.join('// ===== '+name+'.gs =====\n'+(source/(name+'.gs')).read_text() for name in order)
subprocess.run(['node','-e',"new(require('node:vm').Script)(require('node:fs').readFileSync(0,'utf8'));"],input=code,text=True,check=True)
(out/'Code.gs').write_text(code)
for name in ['Index.html','DirectorCorrectionUi.html','appsscript.json']:(out/name).write_bytes((source/name).read_bytes())
legacy=(source/'Legacy.html').read_text().replace('<!-- ADMIN_HELP -->',(source/'AdminHelp.html').read_text().strip())
(out/'Legacy.html').write_text(legacy)
manifest={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(out.iterdir()) if p.is_file() and p.name!='SHA256.json'}
(out/'SHA256.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Build OK: deploy/ — 5 fichiers à installer, plus SHA256.json pour vérification.')

# The demo is assembled from the same UI; its mock bridge never enters deploy/.
demo=ROOT/'demo';demo.mkdir(exist_ok=True)
index=(source/'Index.html').read_text().replace('<script>','<script src="demo.js"></script>\n<script>',1)
index=index.replace('</body>',(source/'DirectorCorrectionUi.html').read_text()+'\n</body>')
(demo/'index.html').write_text(index)
