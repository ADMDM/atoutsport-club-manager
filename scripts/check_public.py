#!/usr/bin/env python3
"""Checks for common accidental disclosures; complements human review."""
from pathlib import Path
import re,sys
ROOT=Path(__file__).resolve().parents[1]
errors=[];checked=0
allowed_email_domains={'example.test','example.invalid','example.com','example.org','example.net','test.invalid'}
for p in sorted(ROOT.rglob('*')):
 if not p.is_file() or any(x in p.parts for x in ['.git','__pycache__','node_modules']):continue
 rel=p.relative_to(ROOT).as_posix()
 if p.name in ['.clasp.json','.clasprc.json','.env','script-properties.json'] or any(x in p.parts for x in ['private','exports','backups']):errors.append(rel+': private configuration or export')
 try:text=p.read_text()
 except UnicodeDecodeError:errors.append(rel+': unexpected binary file');continue
 checked+=1
 if rel=='scripts/check_public.py':continue
 for pattern,label in [(r'AIza[\w-]{30,}','Google API key'),(r'-----BEGIN [A-Z ]*PRIVATE KEY-----','private key'),(r'gh[pousr]_[A-Za-z0-9]{25,}','GitHub credential'),(r'AKfycb[\w-]{30,}','deployment identifier'),(r"[\"']1[A-Za-z0-9_-]{27,}[\"']",'Google resource identifier'),(r'/Users/[^\s\"\']+','local personal path'),(r'(?:/folders/|/d/|id=)[A-Za-z0-9_-]{27,}','Google resource URL')]:
  if re.search(pattern,text):errors.append(rel+': '+label)
 for mail in re.findall(r'[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})',text):
  if mail.lower() not in allowed_email_domains:errors.append(rel+': non-example email domain')
 if re.search(r'data:image/[^;]+;base64,[A-Za-z0-9+/=]{1000,}',text):errors.append(rel+': unreviewed embedded image')
code=(ROOT/'deploy/Code.gs').read_text()
entries=set(re.findall(r'^function (\w+)\(',code,re.M))
public={x for x in entries if not x.endswith('_')}
if public!={'doGet','getPortalConfig','portalRpc'}:errors.append('deploy/Code.gs: unexpected public entry point')
for n in ['Index.html','Legacy.html','DirectorCorrectionUi.html','Code.gs']:
 if 'demo.js' in (ROOT/'deploy'/n).read_text():errors.append('deploy/'+n+': demo included in production')
if errors:
 print('\n'.join(sorted(set(errors))));sys.exit(1)
print(f'Public-content checks passed ({checked} text files). Human review is still required.')
