// Telegram Mini App «Панель CI-фабрики» (Cloudflare Worker).
// GET /app — веб-панель внутри Telegram (кнопка меню бота, как «Open» у BotFather).
// POST /api — действия панели (auth: подпись initData + ALLOWED_USER_ID).
// POST /tg — резервные slash-команды в чате.
// GET /setup?key= — регистрация webhook, команд и кнопки меню.
// GET /selftest?key= — самодиагностика (GitHub-доступ, парсинг конфига).

const REPO = 'nvtoroy/repos-ci-factory';

// ---------- утилиты ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const b64dec = (b) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
const b64enc = (t) => {
  const bytes = new TextEncoder().encode(t);
  let s = '';
  bytes.forEach((c) => (s += String.fromCharCode(c)));
  return btoa(s);
};
const utf8 = (s) => new TextEncoder().encode(s);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hmac(keyBytes, msgBytes) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, msgBytes);
}

// Проверка подписи Telegram WebApp initData + владельца
async function validateInitData(initData, env) {
  const p = new URLSearchParams(initData || '');
  const gotHash = p.get('hash');
  if (!gotHash) return { ok: false, error: 'нет initData' };
  const pairs = [...p.entries()].filter(([k]) => k !== 'hash').map(([k, v]) => `${k}=${v}`).sort();
  const secret = await hmac(utf8('WebAppData'), utf8(env.TELEGRAM_BOT_TOKEN));
  const calc = hex(await hmac(new Uint8Array(secret), utf8(pairs.join('\n'))));
  if (calc !== gotHash) return { ok: false, error: 'невалидная подпись initData' };
  let user = {};
  try { user = JSON.parse(p.get('user') || '{}'); } catch {}
  if (String(user.id) !== String(env.ALLOWED_USER_ID).trim())
    return { ok: false, error: `доступ запрещён (ваш id ${user.id}, разрешён ${String(env.ALLOWED_USER_ID).trim()})` };
  return { ok: true, user };
}

const tg = (env, method, body) =>
  fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const gh = (env, path, init = {}) =>
  fetch('https://api.github.com' + path, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'user-agent': 'ci-factory-bot',
      accept: 'application/vnd.github+json',
      ...(init.headers || {}),
    },
  });

async function getFile(env, path) {
  const r = await gh(env, `/repos/${REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=main`);
  if (!r.ok) throw new Error(`GitHub GET ${path}: HTTP ${r.status}`);
  const j = await r.json();
  return { text: b64dec(j.content), sha: j.sha };
}

async function putFile(env, path, text, sha, message) {
  const body = { message: `bot: ${message}`, content: b64enc(text), sha, branch: 'main' };
  let r = await gh(env, `/repos/${REPO}/contents/${path}`, { method: 'PUT', body: JSON.stringify(body) });
  if (r.status === 409 || r.status === 422) {
    const fresh = await getFile(env, path);
    body.sha = fresh.sha;
    r = await gh(env, `/repos/${REPO}/contents/${path}`, { method: 'PUT', body: JSON.stringify(body) });
  }
  if (!r.ok) throw new Error(`GitHub PUT ${path}: HTTP ${r.status} ${await r.text()}`);
}

async function dispatchBuild(env, name) {
  const r = await gh(env, `/repos/${REPO}/actions/workflows/check.yml/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: 'main', inputs: { force: name } }),
  });
  if (r.status !== 204) throw new Error(`dispatch: HTTP ${r.status} ${await r.text()}`);
}

// ---------- config.yaml: блочные операции ----------
function parseConfig(text) {
  const lines = text.split('\n');
  const blocks = [];
  let header = [];
  let cur = null;
  for (const line of lines) {
    if (/^  - name: /.test(line)) {
      if (cur) blocks.push(cur);
      // inline-комментарии YAML (`# ...`) — не часть значения
      cur = { name: line.replace(/^  - name: /, '').replace(/\s+#.*$/, '').trim(), lines: [line] };
    } else if (cur) cur.lines.push(line);
    else header.push(line);
  }
  if (cur) blocks.push(cur);
  return { header: header.join('\n'), blocks };
}
const renderConfig = (cfg) =>
  (cfg.header.replace(/\n+$/, '') + '\n\n' +
    cfg.blocks.map((b) => b.lines.join('\n').replace(/\n+$/, '')).join('\n\n')
  ).replace(/\n*$/, '\n');

const bGet = (b, re, d = '') => {
  const m = b.lines.join('\n').match(re);
  return m ? m[1].replace(/\s+#.*$/, '').trim() : d;
};
const info = (b) => ({
  name: b.name,
  display: bGet(b, /^ {4}display: (.+)$/m, b.name),
  platform: bGet(b, /^ {4}platform: (\S+)/m, '?'),
  mode: bGet(b, /^ {6}mode: (\S+)/m, 'branch'),
  branch: bGet(b, /^ {6}branch: (\S+)/m, ''),
  paused: bGet(b, /^ {4}paused: (\S+)/m, 'false') === 'true',
  slug: bGet(b, /^ {4}repo: (\S+)/m, '?'),
});
function bSet(block, re, replacement, insertAfterRe) {
  const joined = block.lines.join('\n');
  if (re.test(joined)) block.lines = joined.replace(re, replacement).split('\n');
  else if (insertAfterRe) {
    const i = block.lines.findIndex((l) => insertAfterRe.test(l));
    block.lines.splice(i + 1, 0, replacement);
  }
}

const tplAndroid = (name, slug, display, branch) => `  - name: ${name}
    repo: ${slug}
    display: ${display}
    platform: android
    trigger:
      mode: branch
      branch: ${branch}
    build:
      java: "21"
      gradle_task: "assembleRelease"
      gradle_args: ""
      sdk_packages: ["build-tools;35.0.1"]
      build_tools: "35.0.1"
    artifact:
      glob: "app/build/outputs/apk/release/*.apk"
      name: "${display}-{version}-{sha7}.apk"
    telegram: {}`;

const tplMacos = (name, slug, display, branch) => `  - name: ${name}
    repo: ${slug}
    display: ${display}
    platform: macos
    trigger:
      mode: branch
      branch: ${branch}
    build:
      xcode: "26"
      project: CHECK_ME.xcodeproj
      scheme: "CHECK_ME"
      configuration: Release
      archs: "arm64 x86_64"
      product: CHECK_ME.app
      entitlements_keep:
        - com.apple.security.app-sandbox
        - com.apple.security.network.client
    artifact:
      name: "${display}-macos-{version}-{sha7}.zip"
    telegram:
      note: "Первый запуск: правый клик -> Открыть"`;

const CRON_RE = /^(\S+\s+){4}\S+$/;

// ---------- /api ----------
async function apiHandler(env, body) {
  const { action, params = {} } = body;
  const nameOk = (n) => /^[a-z0-9_-]+$/.test(n || '');

  if (action === 'list') {
    const [cfgF, chkF] = await Promise.all([getFile(env, 'config.yaml'), getFile(env, '.github/workflows/check.yml')]);
    let state = {};
    try { state = JSON.parse((await getFile(env, 'state.json')).text); } catch {}
    const cron = (chkF.text.match(/cron: '([^']+)'/) || [])[1] || '?';
    const repos = parseConfig(cfgF.text).blocks.map((b) => {
      const i = info(b);
      return { ...i, last: state[i.name]?.last?.slice(0, 7) || null, at: state[i.name]?.dispatched_at || null };
    });
    return { repos, cron };
  }

  if (action === 'status') {
    const r = await gh(env, `/repos/${REPO}/actions/runs?per_page=10`);
    const j = await r.json();
    return {
      runs: (j.workflow_runs || []).map((w) => ({
        title: w.display_title, state: w.conclusion || w.status, url: w.html_url,
        at: w.run_started_at,
      })),
    };
  }

  if (action === 'build') {
    if (!nameOk(params.name) && params.name !== 'all') throw new Error('некорректное имя');
    await dispatchBuild(env, params.name);
    return { message: `Запустил: ${params.name}` };
  }

  if (action === 'setCron') {
    const cron = String(params.cron || '').trim();
    if (!CRON_RE.test(cron) || !/^[0-9*,\/\- ]+$/.test(cron)) throw new Error('cron: нужно 5 полей, символы 0-9 * , - /');
    const f = await getFile(env, '.github/workflows/check.yml');
    if (!/cron: '[^']*'/.test(f.text)) throw new Error('не нашёл строку cron в check.yml');
    await putFile(env, '.github/workflows/check.yml', f.text.replace(/cron: '[^']*'/, `cron: '${cron}'`), f.sha, `schedule -> ${cron}`);
    return { message: `Расписание: ${cron}` };
  }

  if (action === 'add') {
    const slug = String(params.slug || '').replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new Error('формат: owner/repo');
    const platform = params.platform === 'macos' ? 'macos' : 'android';
    const mr = await gh(env, `/repos/${slug}`);
    if (!mr.ok) throw new Error(`репозиторий ${slug} не найден (HTTP ${mr.status})`);
    const meta = await mr.json();
    const f = await getFile(env, 'config.yaml');
    const cfg = parseConfig(f.text);
    let name = slug.split('/')[1].toLowerCase().replace(/[^a-z0-9_-]/g, '');
    while (cfg.blocks.some((b) => b.name === name)) name += '2';
    const tpl = platform === 'android' ? tplAndroid : tplMacos;
    cfg.blocks.push({ name, lines: tpl(name, slug, slug.split('/')[1], meta.default_branch || 'main').split('\n') });
    await putFile(env, 'config.yaml', renderConfig(cfg), f.sha, `add ${name} (${platform})`);
    return {
      message: `Добавил ${slug} (${platform})` +
        (platform === 'macos' ? '. ⚠️ Впишите project/scheme/product в config.yaml (CHECK_ME)' : ''),
      name,
    };
  }

  // действия над существующим блоком
  if (!nameOk(params.name)) throw new Error('некорректное имя');
  const f = await getFile(env, 'config.yaml');
  const cfg = parseConfig(f.text);
  const b = cfg.blocks.find((x) => x.name === params.name);
  if (!b) throw new Error(`${params.name}: не найден в конфиге`);
  const i = info(b);

  if (action === 'pause') {
    if (i.paused) b.lines = b.lines.filter((l) => !/^ {4}paused: /.test(l));
    else bSet(b, /^ {4}paused: .*$/m, '    paused: true', /^ {4}platform: /);
    await putFile(env, 'config.yaml', renderConfig(cfg), f.sha, `${i.name}: paused=${!i.paused}`);
    return { message: i.paused ? `${i.name}: сборка включена` : `${i.name}: на паузе` };
  }
  if (action === 'remove') {
    cfg.blocks = cfg.blocks.filter((x) => x.name !== i.name);
    await putFile(env, 'config.yaml', renderConfig(cfg), f.sha, `remove ${i.name}`);
    return { message: `${i.name}: удалён из отслеживания` };
  }
  if (action === 'setBranch') {
    const br = String(params.branch || '').trim();
    if (!/^[\w./-]+$/.test(br)) throw new Error('некорректная ветка');
    bSet(b, /^ {6}branch: .*$/m, `      branch: ${br}`, /^ {6}mode: /);
    await putFile(env, 'config.yaml', renderConfig(cfg), f.sha, `${i.name}: branch -> ${br}`);
    return { message: `${i.name}: ветка ${br}` };
  }
  if (action === 'setMode') {
    const mode = ['branch', 'release', 'tag'].includes(params.mode) ? params.mode : 'branch';
    bSet(b, /^ {6}mode: .*$/m, `      mode: ${mode}`);
    await putFile(env, 'config.yaml', renderConfig(cfg), f.sha, `${i.name}: mode -> ${mode}`);
    return { message: `${i.name}: триггер ${mode}` };
  }
  throw new Error(`неизвестное действие: ${action}`);
}

// ---------- Mini App (HTML) ----------
const APP_HTML = `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CI-фабрика</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; font:15px/1.45 -apple-system,system-ui,sans-serif;
    background: var(--tg-theme-bg-color,#111); color: var(--tg-theme-text-color,#eee); padding:12px 12px 40px; }
  h1 { font-size:19px; margin:4px 0 14px; }
  h2 { font-size:15px; margin:20px 0 8px; opacity:.75; text-transform:uppercase; letter-spacing:.4px; }
  .card { background: var(--tg-theme-secondary-bg-color,#1c1c1e); border-radius:14px; padding:12px 14px; margin-bottom:10px; }
  .title { font-weight:600; }
  .sub { opacity:.65; font-size:13px; margin-top:2px; }
  .row { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
  button { border:0; border-radius:9px; padding:8px 12px; font-size:14px; cursor:pointer;
    background: var(--tg-theme-button-color,#2ea6ff); color: var(--tg-theme-button-text-color,#fff); }
  button.sec { background: color-mix(in srgb, var(--tg-theme-button-color,#2ea6ff) 18%, transparent);
    color: var(--tg-theme-text-color,#eee); }
  button.danger { background:#c0392b; color:#fff; }
  button:disabled { opacity:.5; }
  input, select { border:1px solid rgba(128,128,128,.35); border-radius:9px; padding:8px 10px; font-size:14px;
    background: var(--tg-theme-bg-color,#111); color:inherit; flex:1; min-width:0; }
  .paused { opacity:.55; }
  .badge { font-size:12px; padding:2px 8px; border-radius:20px; background: rgba(128,128,128,.2); }
  #toast { position:fixed; left:12px; right:12px; bottom:14px; background:#000c; color:#fff; padding:10px 14px;
    border-radius:10px; opacity:0; transition:opacity .25s; pointer-events:none; z-index:9; }
  a { color: var(--tg-theme-link-color,#2ea6ff); text-decoration:none; }
  .run { display:flex; gap:8px; align-items:baseline; margin:6px 0; }
  .spin { display:inline-block; animation:r 1s linear infinite; } @keyframes r { to { transform:rotate(360deg);} }
</style></head><body>
<h1>🏭 CI-фабрика</h1>
<div id="repos"><span class="spin">⏳</span> загрузка…</div>

<h2>Добавить репозиторий</h2>
<div class="card"><div class="row">
  <input id="addSlug" placeholder="owner/repo или ссылка GitHub">
  <select id="addPlatform"><option value="android">Android APK</option><option value="macos">macOS app</option></select>
  <button onclick="addRepo()">➕ Добавить</button>
</div></div>

<h2>Расписание проверок</h2>
<div class="card">
  <div class="sub">cron (UTC), 5 полей: минута час день месяц день-недели</div>
  <div class="row">
    <input id="cron" placeholder="7 5 * * *">
    <button onclick="saveCron()">💾 Сохранить</button>
  </div>
  <div class="row">
    <button class="sec" onclick="setCronField('7 5 * * *')">1×/день</button>
    <button class="sec" onclick="setCronField('7 5,17 * * *')">2×/день</button>
    <button class="sec" onclick="setCronField('7 */6 * * *')">каждые 6ч</button>
    <button class="sec" onclick="setCronField('7 * * * *')">каждый час</button>
  </div>
</div>

<h2>Последние сборки</h2>
<div id="runs" class="card">—</div>
<div id="toast"></div>
<script>
const TG = window.Telegram?.WebApp; TG?.ready(); TG?.expand();
function toast(t){ const el=document.getElementById('toast'); el.textContent=t; el.style.opacity=1;
  setTimeout(()=>el.style.opacity=0, 3200); }
async function api(action, params){
  const r = await fetch('/api', {method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({initData: TG?.initData || '', action, params})});
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'ошибка');
  return j;
}
function el(html){ const d=document.createElement('div'); d.innerHTML=html; return d.firstElementChild; }
const escH = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
async function refresh(){
  try {
    const { repos, cron } = await api('list');
    document.getElementById('cron').value = cron;
    const box = document.getElementById('repos'); box.innerHTML='';
    if (!repos.length) box.textContent = 'Репозиториев нет — добавьте ниже.';
    for (const r of repos){
      const icon = r.platform === 'android' ? '🤖' : '🍏';
      const card = el('<div class="card'+(r.paused?' paused':'')+'">'+
        '<div class="title">'+icon+' '+escH(r.display)+' '+(r.paused?'<span class="badge">⏸ пауза</span>':'')+'</div>'+
        '<div class="sub">'+escH(r.slug)+' · '+escH(r.mode)+(r.branch?' @ '+escH(r.branch):'')+
          (r.last?' · собран '+escH(r.last):' · ещё не собран')+'</div>'+
        '<div class="row"></div></div>');
      const row = card.querySelector('.row');
      const btn = (label, cls, fn) => { const b=el('<button class="'+cls+'">'+label+'</button>'); b.onclick=fn; row.appendChild(b); };
      btn('🔨 Собрать', '', async()=>{ toast('Запускаю…'); try{ const x=await api('build',{name:r.name}); toast('✅ '+x.message);}catch(e){toast('⚠️ '+e.message);} });
      btn(r.paused?'▶️ Включить':'⏸ Пауза', 'sec', async()=>{ try{ const x=await api('pause',{name:r.name}); toast('✅ '+x.message); refresh(); }catch(e){toast('⚠️ '+e.message);} });
      btn('🌿 '+(r.branch||'ветка'), 'sec', async()=>{ const br=prompt('Ветка для '+r.name, r.branch||''); if(!br) return;
        try{ const x=await api('setBranch',{name:r.name, branch:br}); toast('✅ '+x.message); refresh(); }catch(e){toast('⚠️ '+e.message);} });
      btn('🔁 '+r.mode, 'sec', async()=>{ const next={branch:'release',release:'tag',tag:'branch'}[r.mode]||'branch';
        try{ const x=await api('setMode',{name:r.name, mode:next}); toast('✅ '+x.message); refresh(); }catch(e){toast('⚠️ '+e.message);} });
      btn('🗑', 'danger', async()=>{ if(!confirm('Удалить '+r.name+' из отслеживания?')) return;
        try{ const x=await api('remove',{name:r.name}); toast('✅ '+x.message); refresh(); }catch(e){toast('⚠️ '+e.message);} });
      box.appendChild(card);
    }
  } catch(e){ document.getElementById('repos').textContent = '⚠️ '+e.message; }
  try {
    const { runs } = await api('status');
    const rb = document.getElementById('runs'); rb.innerHTML='';
    const ic = s => ({success:'✅',failure:'🔴',cancelled:'⚪️',in_progress:'🔵',queued:'🕐'})[s]||'▫️';
    for (const w of runs) rb.appendChild(el('<div class="run">'+ic(w.state)+
      ' <a href="'+w.url+'" target="_blank">'+escH(w.title)+'</a></div>'));
    if (!runs.length) rb.textContent='—';
  } catch(e){ document.getElementById('runs').textContent = '⚠️ '+e.message; }
}
function setCronField(v){ document.getElementById('cron').value = v; }
async function saveCron(){ try{ const x=await api('setCron',{cron:document.getElementById('cron').value});
  toast('✅ '+x.message);}catch(e){toast('⚠️ '+e.message);} }
async function addRepo(){
  const slug=document.getElementById('addSlug').value.trim();
  const platform=document.getElementById('addPlatform').value;
  if(!slug) return toast('Укажите owner/repo');
  toast('Добавляю…');
  try{ const x=await api('add',{slug,platform}); toast('✅ '+x.message);
    document.getElementById('addSlug').value=''; refresh(); }catch(e){ toast('⚠️ '+e.message); }
}
refresh();
</script></body></html>`;

// ---------- чат-команды (резерв) ----------
async function onMessage(env, msg) {
  const chat = msg.chat.id;
  const text = (msg.text || '').trim();
  const panelHint = 'Основное управление — в панели: кнопка «⚙️ Панель» рядом с полем ввода.';

  if (/^\/(start|help)/.test(text))
    return tg(env, 'sendMessage', { chat_id: chat, text: `🏭 CI-фабрика\n\n${panelHint}\n\nРезервные команды:\n/build имя|all — пересобрать\n/schedule 7 5 * * * — задать cron\n/status — последние сборки` });

  if (text.startsWith('/build')) {
    const name = (text.split(/\s+/)[1] || '').toLowerCase();
    if (!/^[a-z0-9_-]+$|^all$/.test(name))
      return tg(env, 'sendMessage', { chat_id: chat, text: 'Формат: /build имя или /build all' });
    await dispatchBuild(env, name);
    return tg(env, 'sendMessage', { chat_id: chat, text: `🔨 Запустил: ${name}` });
  }

  if (text.startsWith('/schedule')) {
    const cron = text.replace(/^\/schedule\s*/, '').trim();
    if (!cron) return tg(env, 'sendMessage', { chat_id: chat, text: `Задать: /schedule 7 5 * * *\n(или через панель — там же пресеты)` });
    const res = await apiHandler(env, { action: 'setCron', params: { cron } });
    return tg(env, 'sendMessage', { chat_id: chat, text: `🕐 ${res.message}` });
  }

  if (text.startsWith('/status')) {
    const { runs } = await apiHandler(env, { action: 'status' });
    const ic = (s) => ({ success: '✅', failure: '🔴', cancelled: '⚪️' }[s] || '🔵');
    return tg(env, 'sendMessage', {
      chat_id: chat, parse_mode: 'HTML', disable_web_page_preview: true,
      text: runs.map((w) => `${ic(w.state)} <a href="${w.url}">${esc(w.title)}</a>`).join('\n') || 'пусто',
    });
  }

  if (text.startsWith('/list')) {
    const { repos, cron } = await apiHandler(env, { action: 'list' });
    const lines = repos.map((r) => `${r.paused ? '⏸' : '🟢'} ${r.display} · ${r.platform} · ${r.mode}${r.branch ? ' @ ' + r.branch : ''}${r.last ? ' · ' + r.last : ''}`);
    return tg(env, 'sendMessage', { chat_id: chat, text: `${lines.join('\n')}\n\ncron: ${cron}\n\n${panelHint}` });
  }

  return tg(env, 'sendMessage', { chat_id: chat, text: panelHint });
}

// ---------- вход ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/app') return new Response(APP_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });

    if (url.pathname === '/api' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch {}
      const auth = await validateInitData(body.initData, env);
      if (!auth.ok) return Response.json({ ok: false, error: auth.error });
      try {
        const res = await apiHandler(env, body);
        return Response.json({ ok: true, ...res });
      } catch (e) {
        return Response.json({ ok: false, error: String(e.message || e) });
      }
    }

    if (url.pathname === '/selftest' && url.searchParams.get('key') === env.WEBHOOK_SECRET) {
      const out = {};
      try { const f = await getFile(env, 'config.yaml'); out.config = { ok: true, repos: parseConfig(f.text).blocks.map((b) => b.name) }; }
      catch (e) { out.config = { ok: false, error: String(e.message || e) }; }
      try { const f = await getFile(env, '.github/workflows/check.yml'); out.checkYml = { ok: true, cron: (f.text.match(/cron: '([^']+)'/) || [])[1] }; }
      catch (e) { out.checkYml = { ok: false, error: String(e.message || e) }; }
      try { const r = await gh(env, `/repos/${REPO}/actions/runs?per_page=1`); out.actions = { ok: r.ok, status: r.status }; }
      catch (e) { out.actions = { ok: false, error: String(e.message || e) }; }
      out.allowedUserId = String(env.ALLOWED_USER_ID).trim();
      return Response.json(out);
    }

    if (url.pathname === '/setup' && url.searchParams.get('key') === env.WEBHOOK_SECRET) {
      const wh = await tg(env, 'setWebhook', {
        url: `${url.origin}/tg`, secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ['message'], drop_pending_updates: true,
      });
      const cmds = await tg(env, 'setMyCommands', {
        commands: [
          { command: 'list', description: 'Список репозиториев' },
          { command: 'build', description: 'Пересобрать: /build имя|all' },
          { command: 'schedule', description: 'Cron: /schedule 7 5 * * *' },
          { command: 'status', description: 'Последние сборки' },
          { command: 'help', description: 'Справка' },
        ],
      });
      const menu = await tg(env, 'setChatMenuButton', {
        menu_button: { type: 'web_app', text: '⚙️ Панель', web_app: { url: `${url.origin}/app` } },
      });
      return Response.json({ webhook: wh, commands: cmds, menu });
    }

    if (url.pathname === '/tg' && request.method === 'POST') {
      if (request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET)
        return new Response('forbidden', { status: 403 });
      const update = await request.json();
      const from = update.message?.from?.id;
      if (String(from) !== String(env.ALLOWED_USER_ID).trim()) return new Response('ok');
      try { if (update.message) await onMessage(env, update.message); }
      catch (e) {
        const chat = update.message?.chat?.id;
        if (chat) await tg(env, 'sendMessage', { chat_id: chat, text: `⚠️ Ошибка: ${String(e.message || e).slice(0, 300)}` });
      }
      return new Response('ok');
    }

    return new Response('ci-factory bot', { status: 200 });
  },
};
