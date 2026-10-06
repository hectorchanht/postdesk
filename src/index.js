/**
 * postdesk — 統一出 post 台
 * One dashboard for the 3 clip IG accounts:
 *   hawley_zh  @snhawleytranslatorhkunofficial （霍利中文）
 *   trump_zh   @trumptranslatorhkunofficial    （特朗普中文）
 *   gns        @globalnewsshorts               (Global News Shorts, EN)
 *
 * Bindings: POSTDESK_KV (KV), MEDIA (R2)
 * Secrets:  DASH_PASSWORD (login), SYNC_SECRET (ingest from VM poller)
 *
 * NOTE: direct IG publishing is blocked (Meta one-account Accounts Center
 * limit — those 3 accounts can't be linked to the connector), so the
 * publish step stays manual in the IG app. This dashboard owns:
 * queue view, one-by-one approval, scheduling, and the post pack
 * (caption copy + media download).
 */

const ACCOUNTS = {
  hawley_zh: { label: '霍利中文', handle: '@snhawleytranslatorhkunofficial' },
  trump_zh:  { label: '特朗普中文', handle: '@trumptranslatorhkunofficial' },
  gns:       { label: 'Global News Shorts', handle: '@globalnewsshorts' },
};
const STATUSES = ['pending', 'approved', 'scheduled', 'posted'];
const STATUS_ZH = { pending: '待批', approved: '已批', scheduled: '已排期', posted: '已出' };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/api/login' && req.method === 'POST') return handleLogin(req, env);
    if (path === '/api/logout' && req.method === 'POST') return handleLogout(req, env);
    if (path === '/api/sync' && req.method === 'POST') return handleSync(req, env);
    if (path === '/api/media' && req.method === 'POST') return handleMediaUpload(req, env);
    if (path.startsWith('/media/') && req.method === 'GET') {
      const ok = await authed(req, env);
      if (!ok) return new Response('unauthorized', { status: 401 });
      const key = decodeURIComponent(path.slice('/media/'.length));
      const obj = await env.MEDIA.get(key);
      if (!obj) return new Response('not found', { status: 404 });
      const ct = key.endsWith('.mp4') ? 'video/mp4'
        : key.endsWith('.png') ? 'image/png'
        : key.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      return new Response(obj.body, { headers: { 'content-type': ct, 'cache-control': 'public, max-age=86400' } });
    }

    const session = await authed(req, env);
    if (!session) {
      if (path.startsWith('/api/')) return json({ error: 'unauthorized' }, 401);
      return loginPage();
    }

    if (path === '/api/queues' && req.method === 'GET') return handleQueues(env);
    if (path === '/api/me' && req.method === 'GET') return json({ ok: true });
    const m = path.match(/^\/api\/items\/([^/]+)\/status$/);
    if (m && req.method === 'POST') return handleStatus(req, env, decodeURIComponent(m[1]));
    const dm = path.match(/^\/api\/items\/([^/]+)$/);
    if (dm && req.method === 'DELETE') return handleDelete(env, decodeURIComponent(dm[1]));

    if (path === '/' && req.method === 'GET') return dashboardPage();
    return new Response('not found', { status: 404 });
  },
};

// ---------- auth ----------
async function authed(req, env) {
  const cookie = req.headers.get('cookie') || '';
  const tok = (/pd_session=([^;]+)/.exec(cookie) || [])[1];
  if (!tok) return null;
  const s = await env.POSTDESK_KV.get('sess:' + tok, 'json');
  return s || null;
}

async function handleLogin(req, env) {
  let body = {};
  try { body = await req.json(); } catch { /* ignore */ }
  if (!body.password || body.password !== env.DASH_PASSWORD) {
    return json({ error: '密碼唔啱' }, 401);
  }
  const tok = crypto.randomUUID();
  await env.POSTDESK_KV.put('sess:' + tok, JSON.stringify({ created: Date.now() }), { expirationTtl: 60 * 60 * 24 * 30 });
  return json({ ok: true }, 200, {
    'set-cookie': `pd_session=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}; Secure`,
  });
}

async function handleLogout(req, env) {
  const cookie = req.headers.get('cookie') || '';
  const tok = (/pd_session=([^;]+)/.exec(cookie) || [])[1];
  if (tok) await env.POSTDESK_KV.delete('sess:' + tok);
  return json({ ok: true }, 200, { 'set-cookie': 'pd_session=; Path=/; Max-Age=0' });
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

// ---------- ingest (VM poller -> KV + R2) ----------
async function handleSync(req, env) {
  if (req.headers.get('x-sync-secret') !== env.SYNC_SECRET) {
    return json({ error: 'bad secret' }, 403);
  }
  let body = {};
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const items = Array.isArray(body.items) ? body.items : [];
  const store = (await env.POSTDESK_KV.get('items', 'json')) || {};
  let upserted = 0;
  for (const it of items) {
    if (!it || !it.id || !ACCOUNTS[it.account]) continue;
    const prev = store[it.id] || {};
    // preserve dashboard-side workflow fields on re-sync; poller owns content fields
    store[it.id] = {
      ...it,
      status: prev.status || (it.posted ? 'posted' : 'pending'),
      scheduled_at: prev.scheduled_at || null,
      posted_url: prev.posted_url || it.posted_url || null,
      posted_at: prev.posted_at || it.posted_at || null,
      synced_at: new Date().toISOString(),
    };
    upserted++;
  }
  await env.POSTDESK_KV.put('items', JSON.stringify(store));
  return json({ ok: true, upserted, total: Object.keys(store).length });
}

async function handleMediaUpload(req, env) {
  if (req.headers.get('x-sync-secret') !== env.SYNC_SECRET) {
    return json({ error: 'bad secret' }, 403);
  }
  const form = await req.formData();
  const key = String(form.get('key') || '');
  const file = form.get('file');
  if (!key || !file || typeof file.arrayBuffer !== 'function') {
    return json({ error: 'need key + file' }, 400);
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(key) || key.includes('..')) return json({ error: 'bad key' }, 400);
  const buf = await file.arrayBuffer();
  if (buf.byteLength > 100 * 1024 * 1024) return json({ error: 'file too big' }, 413);
  const ct = file.type || 'application/octet-stream';
  await env.MEDIA.put(key, buf, { httpMetadata: { contentType: ct } });
  return json({ ok: true, key, bytes: buf.byteLength });
}

// ---------- dashboard reads / writes ----------
async function handleQueues(env) {
  const store = (await env.POSTDESK_KV.get('items', 'json')) || {};
  const items = Object.values(store).sort((a, b) =>
    String(b.queued_at || '').localeCompare(String(a.queued_at || '')));
  return json({ accounts: ACCOUNTS, statuses: STATUS_ZH, items });
}

async function handleStatus(req, env, id) {
  let body = {};
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const { status, scheduled_at, posted_url } = body;
  if (!STATUSES.includes(status)) return json({ error: 'bad status' }, 400);
  const store = (await env.POSTDESK_KV.get('items', 'json')) || {};
  const it = store[id];
  if (!it) return json({ error: 'not found' }, 404);
  it.status = status;
  if (status === 'scheduled') {
    if (!scheduled_at) return json({ error: 'need scheduled_at' }, 400);
    it.scheduled_at = scheduled_at;
  } else if (status !== 'scheduled') {
    it.scheduled_at = null;
  }
  if (status === 'posted') {
    it.posted_at = new Date().toISOString();
    if (posted_url) it.posted_url = posted_url;
  }
  await env.POSTDESK_KV.put('items', JSON.stringify(store));
  return json({ ok: true, item: it });
}

async function handleDelete(env, id) {
  const store = (await env.POSTDESK_KV.get('items', 'json')) || {};
  if (!store[id]) return json({ error: 'not found' }, 404);
  delete store[id];
  await env.POSTDESK_KV.put('items', JSON.stringify(store));
  return json({ ok: true, deleted: id });
}

// ---------- pages ----------
function loginPage() {
  return new Response(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>出 post 台 — 登入</title>
<style>
body{background:#0b0d12;color:#e8eaf0;font-family:-apple-system,"PingFang HK","Microsoft JhengHei",sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#141824;border:1px solid #262c3d;border-radius:14px;padding:32px;width:min(360px,90vw)}
h1{font-size:20px;margin:0 0 6px}.sub{color:#8b93a7;font-size:13px;margin:0 0 20px}
input{width:100%;box-sizing:border-box;background:#0b0d12;border:1px solid #2b3247;color:#e8eaf0;border-radius:10px;padding:12px;font-size:16px}
button{width:100%;margin-top:12px;background:#4f7cff;border:0;color:#fff;border-radius:10px;padding:12px;font-size:16px;font-weight:700;cursor:pointer}
.err{color:#ff7a7a;font-size:13px;min-height:20px;margin-top:8px}
</style></head><body><div class="box">
<h1>📮 出 post 台</h1><p class="sub">統一 IG 出 post dashboard</p>
<input id="pw" type="password" placeholder="密碼" autocomplete="current-password">
<button onclick="go()">登入</button><div class="err" id="err"></div>
<script>
async function go(){
  const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
  if(r.ok) location.href='/'; else document.getElementById('err').textContent='密碼唔啱';
}
document.getElementById('pw').addEventListener('keydown',e=>{if(e.key==='Enter')go()});
</script></div></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function dashboardPage() {
  return new Response(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>出 post 台</title>
<style>
:root{--bg:#0b0d12;--card:#141824;--line:#262c3d;--txt:#e8eaf0;--dim:#8b93a7;--acc:#4f7cff;--ok:#3ecf8e;--warn:#ffb020;--bad:#ff7a7a}
*{box-sizing:border-box}body{background:var(--bg);color:var(--txt);font-family:-apple-system,"PingFang HK","Microsoft JhengHei",sans-serif;margin:0;padding:0 0 80px}
header{position:sticky;top:0;z-index:10;background:rgba(11,13,18,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:12px 16px}
header h1{font-size:17px;margin:0;display:flex;justify-content:space-between;align-items:center}
header h1 button{background:none;border:1px solid var(--line);color:var(--dim);border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer}
.tabs{display:flex;gap:8px;padding:12px 16px 0;overflow-x:auto}
.tab{flex:1;min-width:0;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 8px;text-align:center;cursor:pointer;white-space:nowrap}
.tab .t{font-size:14px;font-weight:700}.tab .h{font-size:11px;color:var(--dim);margin-top:2px;overflow:hidden;text-overflow:ellipsis}
.tab .n{display:inline-block;min-width:20px;background:#2a3044;color:#cfd6e6;border-radius:10px;font-size:11px;padding:1px 6px;margin-top:4px}
.tab .n.hot{background:var(--warn);color:#111;font-weight:700}
.tab.on{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc)}
.filters{display:flex;gap:8px;padding:12px 16px;overflow-x:auto}
.f{background:var(--card);border:1px solid var(--line);color:var(--dim);border-radius:20px;padding:6px 14px;font-size:13px;cursor:pointer;white-space:nowrap}
.f.on{background:var(--acc);border-color:var(--acc);color:#fff}
.due{margin:12px 16px 0;background:#2a2113;border:1px solid var(--warn);border-radius:12px;padding:12px 14px;font-size:14px}
.due b{color:var(--warn)}
.list{padding:12px 16px;display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.media{width:100%;aspect-ratio:4/5;max-height:380px;object-fit:cover;background:#000;display:block}
.body{padding:12px 14px}
.meta{font-size:12px;color:var(--dim);display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.pill{border:1px solid var(--line);border-radius:12px;padding:2px 8px}
.pill.pending{color:var(--warn);border-color:var(--warn)}.pill.approved{color:var(--acc);border-color:var(--acc)}
.pill.scheduled{color:#b48cff;border-color:#b48cff}.pill.posted{color:var(--ok);border-color:var(--ok)}
.cap{font-size:14px;line-height:1.55;white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;margin:0 0 10px}
.cap.full{-webkit-line-clamp:unset}
.src{font-size:12px;color:var(--dim);margin-bottom:10px}.src a{color:var(--acc)}
.acts{display:flex;gap:8px;flex-wrap:wrap}
.btn{border:1px solid var(--line);background:#1b2130;color:var(--txt);border-radius:10px;padding:9px 14px;font-size:14px;cursor:pointer}
.btn.go{background:var(--ok);border-color:var(--ok);color:#06130c;font-weight:700}
.btn.pri{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:700}
.btn.danger{color:var(--bad)}
.sched{display:none;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap}
.sched.open{display:flex}
.sched input{background:var(--bg);border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:8px;font-size:14px}
.pack{display:none;margin-top:10px;background:#0e1119;border:1px solid var(--line);border-radius:10px;padding:10px}
.pack.open{display:block}
.pack textarea{width:100%;min-height:150px;background:var(--bg);border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:8px;font-size:13px;font-family:inherit}
.pack .row{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.pack a{color:var(--acc);font-size:13px}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#222a3f;border:1px solid var(--line);color:var(--txt);padding:10px 18px;border-radius:12px;font-size:14px;display:none;z-index:50}
.empty{padding:40px 16px;text-align:center;color:var(--dim)}
</style></head><body>
<header><h1>📮 出 post 台 <button onclick="logout()">登出</button></h1></header>
<div class="tabs" id="tabs"></div>
<div id="due"></div>
<div class="filters" id="filters"></div>
<div class="list" id="list"></div>
<div class="toast" id="toast"></div>
<script>
let DATA={accounts:{},statuses:{},items:[]};
let tab='hawley_zh', filt='all';
const $=id=>document.getElementById(id);
function toast(m){const t=$('toast');t.textContent=m;t.style.display='block';clearTimeout(t._h);t._h=setTimeout(()=>t.style.display='none',2200)}
async function api(p,o={}){const r=await fetch(p,{headers:{'content-type':'application/json'},...o});if(r.status===401){location.reload();throw 0}return r.json()}
async function load(){DATA=await api('/api/queues');render()}
function logout(){fetch('/api/logout',{method:'POST'}).then(()=>location.reload())}
function counts(a){const c={pending:0,approved:0,scheduled:0,posted:0,all:0};DATA.items.filter(i=>i.account===a).forEach(i=>{c.all++;c[i.status]=(c[i.status]||0)+1});return c}
function render(){
  const tabs=$('tabs');tabs.innerHTML='';
  for(const [k,a] of Object.entries(DATA.accounts)){
    const c=counts(k),d=document.createElement('div');
    d.className='tab'+(k===tab?' on':'');
    d.innerHTML='<div class="t">'+a.label+'</div><div class="h">'+a.handle+'</div><div><span class="n'+(c.pending?' hot':'')+'">'+c.pending+' 待批</span></div>';
    d.onclick=()=>{tab=k;render()};tabs.appendChild(d);
  }
  const now=new Date();
  const due=DATA.items.filter(i=>i.status==='scheduled'&&i.scheduled_at&&new Date(i.scheduled_at)<=now);
  $('due').innerHTML=due.length?'<div class="due">⏰ <b>'+due.length+' 條到鐘未出</b> — 排期時間已到，㩒入去逐個出 post</div>':'';
  const fs=[['all','全部'],['pending','待批'],['approved','已批'],['scheduled','已排期'],['posted','已出']];
  const flt=$('filters');flt.innerHTML='';
  fs.forEach(([k,l])=>{const b=document.createElement('button');b.className='f'+(filt===k?' on':'');b.textContent=l;b.onclick=()=>{filt=k;render()};flt.appendChild(b)});
  const list=$('list');list.innerHTML='';
  let items=DATA.items.filter(i=>i.account===tab&&(filt==='all'||i.status===filt));
  if(!items.length){list.innerHTML='<div class="empty">呢個 tab 暫時冇嘢'+(tab==='trump_zh'?'<br>等緊 poller 產出特朗普中文翻譯':'')+'</div>';return}
  items.forEach(it=>{
    const card=document.createElement('div');card.className='card';
    const m0=(it.media&&it.media[0])||null;
    let mediaHtml='';
    if(m0){const src='/media/'+encodeURIComponent(m0.key);
      mediaHtml=m0.kind==='video'?'<video class="media" src="'+src+'" controls preload="metadata" playsinline></video>'
        :'<img class="media" src="'+src+'" loading="lazy">';}
    const stName=DATA.statuses[it.status]||it.status;
    let sched='';
    if(it.status==='scheduled'&&it.scheduled_at){const d=new Date(it.scheduled_at);sched='<span class="pill">📅 '+d.toLocaleString('zh-HK',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})+'</span>'}
    card.innerHTML=mediaHtml+'<div class="body">'
      +'<div class="meta"><span class="pill '+it.status+'">'+stName+'</span>'+sched
      +'<span class="pill">'+(it.media_type||'')+'</span>'
      +(it.warnings&&it.warnings.length?'<span class="pill" style="color:var(--bad);border-color:var(--bad)">⚠ '+it.warnings.length+'</span>':'')
      +'<span>'+(it.created_at||'').slice(0,10)+'</span></div>'
      +'<p class="cap" onclick="this.classList.toggle(\\'full\\')">'+esc((it.suggested_post||it.caption_zh||'').slice(0,400))+'</p>'
      +'<div class="src">來源：<a href="'+it.url+'" target="_blank" rel="noopener">原 post ↗</a></div>'
      +'<div class="acts">'
      +(it.status==='pending'?'<button class="btn go" onclick="setStatus(\\''+it.id+'\\',\\'approved\\')">✓ 批</button>':'')
      +(it.status==='approved'?'<button class="btn pri" onclick="toggleSched(\\''+it.id+'\\')">📅 排期</button><button class="btn" onclick="pack(\\''+it.id+'\\')">📦 出 post 包</button>':'')
      +(it.status==='scheduled'?'<button class="btn" onclick="pack(\\''+it.id+'\\')">📦 出 post 包</button><button class="btn go" onclick="markPosted(\\''+it.id+'\\')">✓ 已出</button>':'')
      +(it.status!=='pending'&&it.status!=='posted'?'<button class="btn danger" onclick="setStatus(\\''+it.id+'\\',\\'pending\\')">打回</button>':'')
      +(it.posted_url?'<a class="btn" style="text-decoration:none;display:inline-block" href="'+it.posted_url+'" target="_blank" rel="noopener">睇已出 ↗</a>':'')
      +'</div>'
      +'<div class="sched" id="sched-'+it.id+'"><input type="datetime-local" id="dt-'+it.id+'"><button class="btn pri" onclick="doSchedule(\\''+it.id+'\\')">確定</button></div>'
      +'<div class="pack" id="pack-'+it.id+'"></div>'
      +'</div>';
    list.appendChild(card);
  });
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
async function setStatus(id,status,extra={}){
  const r=await api('/api/items/'+encodeURIComponent(id)+'/status',{method:'POST',body:JSON.stringify({status,...extra})});
  if(r.ok){toast('搞掂 ✓');load()}else toast('出錯：'+(r.error||'未知'))
}
function toggleSched(id){$('sched-'+id).classList.toggle('open')}
async function doSchedule(id){
  const v=$('dt-'+id).value;if(!v){toast('揀個日子時間先');return}
  setStatus(id,'scheduled',{scheduled_at:new Date(v).toISOString()});
}
async function markPosted(id){
  const u=prompt('IG post 連結（唔填都得）：','');
  if(u===null)return;
  setStatus(id,'posted',u?{posted_url:u}:{}
...[truncated 1998 chars]