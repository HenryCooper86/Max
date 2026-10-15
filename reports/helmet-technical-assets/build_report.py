from pathlib import Path
import csv, re, html
from PIL import Image, ImageDraw, ImageFont

BASE = Path('/Users/admin/doubao/reports')
OUT = BASE / 'helmet-technical-assets'
FONT = '/System/Library/Fonts/Helvetica.ttc'
INK='#182d3b'; MUTED='#536875'; BG='#f7f9fa'

class Canvas:
    def __init__(self,w,h):
        self.w,self.h=w,h
        self.im=Image.new('RGB',(w,h),BG); self.d=ImageDraw.Draw(self.im)
        self.svg=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}"><rect width="100%" height="100%" fill="{BG}"/>']
    def rect(self,x,y,w,h,fill):
        self.d.rectangle((x,y,x+w,y+h),fill=fill)
        self.svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}"/>')
    def text(self,x,y,t,size=22,fill=INK,bold=False):
        font=ImageFont.truetype(FONT,size,index=1 if bold else 0)
        self.d.text((x,y),t,font=font,fill=fill)
        self.svg.append(f'<text x="{x}" y="{y+size}" font-family="Helvetica,Arial,sans-serif" font-size="{size}" font-weight="{700 if bold else 400}" fill="{fill}">{html.escape(t)}</text>')
    def save(self,name):
        self.im.save(OUT/f'{name}.png')
        (OUT/f'{name}.svg').write_text('\n'.join(self.svg+['</svg>']))

cols=['Voice/device\ncontrol','Navigation\noutput','Video\ncapture','Camera-question\nAI pipeline','Optical\nhelmet HUD','Action-result\nchecks disclosed']
sources={
'MAX':'/Users/admin/doubao/README.md; /Users/admin/doubao/server/device-actions.ts; /Users/admin/doubao/server/vision.ts; /Users/admin/doubao/docs/rdk-hud-casting.md',
'Sena 60S':'https://www.sena.com/product/60s/; https://firmware.sena.com/senabluetoothmanager/UserGuide_60S_1.1.1_en_250314.pdf',
'Sena 50C':'https://www.sena.com/product/50c/',
'Cardo PACKTALK PRO':'https://cardosystems.com/products/packtalk-pro; https://cardosystems.com/blogs/cardo-blog/summer-touring-setup-connected',
'GT-AIR 3 Smart':'https://eye-lights.com/products/gt-air3smart',
'LIVALL MC1 Pro':'https://de.livall.com/en/products/mc1-pro',
'AtherStack 7':'https://www.atherenergy.com/ota-updates; https://forum.atherenergy.com/t/voice-on-ather-now-live-atherstack-7/436757',
'RAGA':'https://ragarider.com/'}
rows=[('MAX','Software / embedded prototype',['I','I','I','P','N','I']),('Sena 60S','Commercial listing',['D','D','?','?','?','?']),('Sena 50C','Commercial listing',['D','D','D','?','?','?']),('Cardo PACKTALK PRO','Commercial listing',['D','D','?','?','?','?']),('GT-AIR 3 Smart','Pre-order; shipping unverified',['D','D','?','?','D','?']),('LIVALL MC1 Pro','Regional listing; stock unverified',['?','?','D','?','?','?']),('AtherStack 7','Official launch / OTA',['D','D','?','?','?','?']),('RAGA','In development',['D','D','?','?','?','?'])]
styles={'I':('#127b78','Implemented'), 'D':('#294c69','Documented'), 'P':('#ebc86a','Unverified'), 'N':('#e1e6ea','Not built'), '?':('#e9edf0','Not documented')}
with (OUT/'capability-evidence-matrix.csv').open('w') as f:
    writer=csv.writer(f); writer.writerow(['product','maturity','capability','evidence_category','source','scope_note','review_date'])
    for name,maturity,cells in rows:
        for col,key in zip(cols,cells):
            note='Not documented is unknown, not absent. No performance comparison.'
            if name=='MAX':note='Implementation is code/prototype evidence, not production/riding validation; grammar-based supported commands; camera live provider unverified; RDK screen is not optical HUD.'
            elif name=='RAGA':note='Vendor describes intended functionality while in development; release not verified.'
            elif 'Navigation' in col:note='Broad category includes phone-assistant audio, route software or displays; not equivalent navigation capability.'
            writer.writerow([name,maturity,col.replace('\n',' '),styles[key][1],sources[name],note,'2026-10-04'])

c=Canvas(1680,1070)
c.text(48,34,'Where MAX fits in the rider-assistance landscape',38,bold=True)
c.text(48,91,'Evidence of capability, not a ranking of quality or readiness  |  4 October 2026',24,fill=MUTED)
startx=380; cw=205
for j,col in enumerate(cols):
    for k,line in enumerate(col.split('\n')):c.text(startx+j*cw+12,155+k*27,line,21,bold=True)
for i,(name,maturity,cells) in enumerate(rows):
    y=230+i*78
    c.text(48,y+5,name,24,bold=True); c.text(48,y+37,maturity,16,fill=MUTED)
    for j,key in enumerate(cells):
        fill,label=styles[key]; c.rect(startx+j*cw,y,cw-8,66,fill)
        c.text(startx+j*cw+12,y+20,label,19,fill='white' if key in ('I','D') else INK,bold=key in ('I','D'))
c.text(48,884,'Legend',20,bold=True)
for x,key,caption in [(160,'D','Vendor claim'),(440,'I','MAX code/prototype'),(800,'P','Live validation pending'),(1210,'N','No MAX optical HUD')]:
    c.rect(x,883,22,22,styles[key][0]); c.text(x+32,881,caption,19)
c.text(48,939,'Gray “Not documented” means unknown in reviewed public sources; it does not mean the competitor lacks the feature.',22,bold=True)
c.text(48,977,'Navigation output spans audio, apps and displays. RAGA claims concern a product in development. No aggregate score is calculated.',20,fill=MUTED)
c.text(48,1011,'Sources: manufacturer pages and MAX repository; cell-level references and scope notes are in capability-evidence-matrix.csv.',19,fill=MUTED)
c.save('capability-evidence-matrix')

with (OUT/'audio-reference-lag.csv').open('w') as f:
    writer=csv.writer(f); writer.writerow(['stage','reference_to_microphone_lag_ms','measurement_date','evidence','source','limitations'])
    for stage,value in [('Before integration fix',953),('After integration fix',81)]:
        writer.writerow([stage,value,'2026-07-26','Documented internal prototype measurement','/Users/admin/doubao/rdk/README.md:315','Not AI response latency; not competitor benchmark; raw logs not replayed; no statistical distribution provided'])
c=Canvas(1500,860)
c.text(55,42,'An audio integration fix reduced reference lag',37,bold=True)
c.text(55,101,'Internal headset prototype measurement  |  26 July 2026  |  Lower is better for this metric',22,fill=MUTED)
c.text(55,180,'REFERENCE-TO-MICROPHONE SYNCHRONIZATION LAG',20,bold=True)
bx=390; scale=.91
for y,label,val,fill in [(270,'Before fix',953,'#688394'),(435,'After fix',81,'#127b78')]:
    c.text(55,y+20,label,29,bold=True);c.rect(bx,y,val*scale,85,fill);c.text(bx+val*scale+18,y+22,f'{val} ms',29,bold=True)
c.text(390,562,'0',19,fill=MUTED);c.text(819,562,'500 ms',19,fill=MUTED);c.text(1250,562,'1,000 ms',19,fill=MUTED)
c.rect(55,635,1390,2,'#d8e1e6')
c.text(55,668,'91.5% reduction',37,fill='#127b78',bold=True)
c.text(465,670,'872 ms less synchronization lag in the recorded iteration',25)
c.text(55,740,'This is NOT end-to-end AI response latency, a wind-noise test, or a comparison with competitors.',23,bold=True)
c.text(55,784,'Source: MAX rdk/README.md, line 315. Internal record; raw recordings/logs were not replayed in this review.',21,fill=MUTED)
c.save('audio-reference-lag')

# Minimal deterministic Markdown conversion for the static, self-contained report.
md=(BASE/'Helmet technical competitive advantage.md').read_text()
def inline(s):
    s=html.escape(s)
    s=re.sub(r'\[([^\]]+)\]\(([^)]+)\)',r'<a href="\2">\1</a>',s)
    s=re.sub(r'\*\*([^*]+)\*\*',r'<strong>\1</strong>',s)
    s=re.sub(r'`([^`]+)`',r'<code>\1</code>',s)
    if s.startswith('*') and s.endswith('*'):s='<em>'+s[1:-1]+'</em>'
    return s
parts=[]; lines=md.splitlines(); i=0
while i<len(lines):
    line=lines[i]
    if not line.strip():i+=1;continue
    if line.startswith('!['):
        path=re.search(r'\(([^)]+)\)',line).group(1)
        svg=(BASE/path).with_suffix('.svg').read_text();parts.append('<figure>'+svg+'</figure>');i+=1;continue
    if line.startswith('|'):
        table=[]
        while i<len(lines) and lines[i].startswith('|'):
            cells=[x.strip() for x in lines[i].strip('|').split('|')]
            if not all(re.match(r'^:?-+:?$',x) for x in cells):table.append(cells)
            i+=1
        parts.append('<div class="table-scroll"><table><thead><tr>'+''.join('<th>'+inline(x)+'</th>' for x in table[0])+'</tr></thead><tbody>'+''.join('<tr>'+''.join('<td>'+inline(x)+'</td>' for x in row)+'</tr>' for row in table[1:])+'</tbody></table></div>');continue
    if line.startswith('>'):
        p=[]
        while i<len(lines) and lines[i].startswith('>'):
            if lines[i][1:].strip():p.append('<p>'+inline(lines[i][1:].strip())+'</p>')
            i+=1
        parts.append('<blockquote>'+''.join(p)+'</blockquote>');continue
    if line.startswith('# '):parts.append('<h1>'+inline(line[2:])+'</h1>')
    elif line.startswith('## '):parts.append('<h2>'+inline(line[3:])+'</h2>')
    elif line=='---':parts.append('<hr>')
    else:parts.append('<p>'+inline(line)+'</p>')
    i+=1
doc='''<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MAX — Technical advantage evidence</title><style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f0f4f5;color:#182d3b;font:17px/1.68 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1160px;margin:44px auto;background:#fff;padding:60px 68px;box-shadow:0 10px 50px #18313a0b}.eyebrow{font-size:12px;letter-spacing:.16em;color:#127b78;font-weight:750;text-transform:uppercase}h1{font-size:48px;letter-spacing:-.035em;line-height:1.1;margin:20px 0 28px;max-width:800px}h2{font-size:28px;line-height:1.25;letter-spacing:-.02em;margin:54px 0 20px;padding-top:24px;border-top:1px solid #dce5e8}p{margin:16px 0}strong{font-weight:700}a{color:#116e80;text-decoration-thickness:1px;text-underline-offset:3px}blockquote{margin:22px 0;padding:18px 30px;background:#eef7f5;border-left:4px solid #127b78;font-size:18px}blockquote p:first-child{margin-top:0}blockquote p:last-child{margin-bottom:0}figure{margin:28px -28px}svg{width:100%;height:auto;display:block}table{border-collapse:collapse;width:100%;font-size:14px;line-height:1.5}th{text-align:left;background:#203e51;color:#fff;font-weight:600}th,td{padding:14px;vertical-align:top;border-bottom:1px solid #dce5e8}tbody tr:nth-child(even){background:#f5f8f9}.table-scroll{overflow-x:auto}code{font-size:.87em;background:#edf1f3;padding:2px 5px}em{font-size:14px;color:#5d6d77}hr{border:0;border-top:1px solid #dce5e8;margin:45px 0}.footer{margin-top:42px;font-size:12px;letter-spacing:.05em;color:#62747e}@media(max-width:700px){main{margin:0;padding:30px 22px}h1{font-size:35px}h2{font-size:24px}figure{margin:20px -10px}blockquote{padding:16px 20px}body{font-size:16px}}@media print{body{background:white}main{margin:0;padding:15px;box-shadow:none}h2{break-after:avoid}figure,blockquote,tr{break-inside:avoid}a{color:inherit}}
</style></head><body><main><div class="eyebrow">MAX / Business plan evidence brief / 04 October 2026</div>'''+''.join(parts)+'''<div class="footer">NON-ARAS TECHNICAL POSITIONING · EVIDENCE BEFORE SUPERIORITY CLAIMS</div></main></body></html>'''
(BASE/'Helmet technical competitive advantage.html').write_text(doc)
print('Created report, self-contained HTML, two PNG/SVG charts and two source CSVs.')
