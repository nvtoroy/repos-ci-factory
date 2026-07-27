// Telegram Mini App «Панель CI-фабрики» (Cloudflare Worker).
// GET /app — веб-панель внутри Telegram (кнопка меню бота).
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

async function validateInitData(initData, env) {
  const p = new URLSearchParams(initData || '');
  const gotHash = p.get('hash');
  if (!gotHash) return { ok: false, error: 'нет initData — откройте панель из Telegram' };
  const pairs = [...p.entries()].filter(([k]) => k !== 'hash').map(([k, v]) => `${k}=${v}`).sort();
  const secret = await hmac(utf8('WebAppData'), utf8(env.TELEGRAM_BOT_TOKEN));
  const calc = hex(await hmac(new Uint8Array(secret), utf8(pairs.join('\n'))));
  if (calc !== gotHash) return { ok: false, error: 'невалидная подпись initData' };
  let user = {};
  try { user = JSON.parse(p.get('user') || '{}'); } catch {}
  if (String(user.id) !== String(env.ALLOWED_USER_ID).trim())
    return { ok: false, error: `доступ запрещён (ваш id ${user.id})` };
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

// ---------- config.yaml: блочные операции (канонический формат) ----------
function parseConfig(text) {
  const lines = text.split('\n');
  const blocks = [];
  let header = [];
  let cur = null;
  for (const line of lines) {
    if (/^  - name: /.test(line)) {
      if (cur) blocks.push(cur);
      // inline-комментарии YAML — не часть значения
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
      return { ...i, last: state[i.name]?.last || null, at: state[i.name]?.dispatched_at || null };
    });
    return { repos, cron };
  }

  if (action === 'status') {
    const r = await gh(env, `/repos/${REPO}/actions/runs?per_page=10`);
    const j = await r.json();
    return {
      runs: (j.workflow_runs || []).map((w) => ({
        title: w.display_title, state: w.conclusion || w.status, url: w.html_url, at: w.run_started_at,
      })),
    };
  }

  if (action === 'build') {
    if (!nameOk(params.name) && params.name !== 'all') throw new Error('некорректное имя');
    await dispatchBuild(env, params.name);
    return { message: `Сборка запущена: ${params.name}` };
  }

  if (action === 'setCron') {
    const cron = String(params.cron || '').trim();
    if (!CRON_RE.test(cron) || !/^[0-9*,\/\- ]+$/.test(cron)) throw new Error('cron: нужно 5 полей, символы 0-9 * , - /');
    const f = await getFile(env, '.github/workflows/check.yml');
    if (!/cron: '[^']*'/.test(f.text)) throw new Error('не нашёл строку cron в check.yml');
    await putFile(env, '.github/workflows/check.yml', f.text.replace(/cron: '[^']*'/, `cron: '${cron}'`), f.sha, `schedule -> ${cron}`);
    return { message: 'Расписание сохранено' };
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
      message: `Добавлен ${slug}` +
        (platform === 'macos' ? '. Впишите project/scheme/product в config.yaml (CHECK_ME)' : ''),
      name,
    };
  }

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
    return { message: i.paused ? 'Сборка включена' : 'Сборка приостановлена' };
  }
  if (action === 'remove') {
    cfg.blocks = cfg.blocks.filter((x) => x.name !== i.name);
    await putFile(env, 'config.yaml', renderConfig(cfg), f.sha, `remove ${i.name}`);
    return { message: `${i.display}: больше не отслеживается` };
  }
  if (action === 'setBranch') {
    const br = String(params.branch || '').trim();
    if (!/^[\w./-]+$/.test(br)) throw new Error('некорректное имя ветки');
    bSet(b, /^ {6}branch: .*$/m, `      branch: ${br}`, /^ {6}mode: /);
    await putFile(env, 'config.yaml', renderConfig(cfg), f.sha, `${i.name}: branch -> ${br}`);
    return { message: `Ветка: ${br}` };
  }
  if (action === 'setMode') {
    const mode = ['branch', 'release', 'tag'].includes(params.mode) ? params.mode : 'branch';
    bSet(b, /^ {6}mode: .*$/m, `      mode: ${mode}`);
    await putFile(env, 'config.yaml', renderConfig(cfg), f.sha, `${i.name}: mode -> ${mode}`);
    return { message: 'Режим обновлён' };
  }
  throw new Error(`неизвестное действие: ${action}`);
}

// ---------- Mini App ----------
const APP_HTML = `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>CI-фабрика</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root { color-scheme: light dark;
    --bg: var(--tg-theme-bg-color,#0f0f10);
    --card: var(--tg-theme-secondary-bg-color,#1b1b1d);
    --tx: var(--tg-theme-text-color,#f2f2f5);
    --sub: var(--tg-theme-hint-color,#8e8e93);
    --acc: var(--tg-theme-button-color,#2ea6ff);
    --acc-tx: var(--tg-theme-button-text-color,#fff);
    --line: color-mix(in srgb, var(--sub) 22%, transparent);
    --danger:#e5484d;
  }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body { margin:0; font:15px/1.45 -apple-system,system-ui,Roboto,sans-serif; background:var(--bg); color:var(--tx); padding:14px 14px 48px; }
  h1 { font-size:20px; margin:2px 0 2px; letter-spacing:-.2px; }
  .sum { color:var(--sub); font-size:13px; margin-bottom:16px; }
  h2 { font-size:13px; margin:22px 4px 8px; color:var(--sub); font-weight:600; text-transform:uppercase; letter-spacing:.5px; }
  .card { background:var(--card); border-radius:16px; margin-bottom:10px; overflow:hidden; }
  .rhead { padding:13px 14px; display:flex; align-items:center; gap:11px; cursor:pointer; }
  .ricon { font-size:22px; }
  .rmain { flex:1; min-width:0; }
  .rtitle { font-weight:600; display:flex; align-items:center; gap:8px; }
  .rsub { color:var(--sub); font-size:13px; margin-top:1px; }
  .chip { font-size:11px; font-weight:600; padding:2px 8px; border-radius:20px; white-space:nowrap; }
  .chip.on { background:color-mix(in srgb,#30d158 18%,transparent); color:#30d158; }
  .chip.off { background:color-mix(in srgb,var(--sub) 18%,transparent); color:var(--sub); }
  .chev { color:var(--sub); transition:transform .18s; font-size:13px; }
  .open .chev { transform:rotate(90deg); }
  .body { display:none; border-top:1px solid var(--line); padding:12px 14px 14px; }
  .open .body { display:block; }
  .btn { display:block; width:100%; border:0; border-radius:11px; padding:11px; font-size:15px; font-weight:600;
    background:var(--acc); color:var(--acc-tx); cursor:pointer; margin-bottom:12px; }
  .btn:disabled { opacity:.55; }
  .lbl { font-size:12px; font-weight:600; color:var(--sub); text-transform:uppercase; letter-spacing:.4px; margin:12px 0 6px; }
  .opt { display:flex; gap:10px; padding:10px 10px; border-radius:11px; cursor:pointer; align-items:flex-start; }
  .opt.sel { background:color-mix(in srgb,var(--acc) 12%,transparent); }
  .opt .tick { width:18px; color:var(--acc); font-weight:700; }
  .opt .ot { font-weight:600; font-size:14px; }
  .opt .od { color:var(--sub); font-size:12.5px; margin-top:1px; }
  .row { display:flex; gap:8px; align-items:center; }
  input, select { border:1px solid var(--line); border-radius:10px; padding:9px 11px; font-size:14px;
    background:var(--bg); color:inherit; flex:1; min-width:0; outline:none; }
  input:focus { border-color:var(--acc); }
  .sbtn { border:0; border-radius:10px; padding:9px 14px; font-size:14px; font-weight:600;
    background:color-mix(in srgb,var(--acc) 16%,transparent); color:var(--acc); cursor:pointer; white-space:nowrap; }
  .switchrow { display:flex; align-items:center; justify-content:space-between; padding:10px 2px; }
  .sw { position:relative; width:46px; height:28px; border-radius:20px; background:var(--line); transition:.2s; cursor:pointer; flex:none; }
  .sw.on { background:#30d158; }
  .sw::after { content:''; position:absolute; top:2px; left:2px; width:24px; height:24px; border-radius:50%; background:#fff; transition:.2s; }
  .sw.on::after { left:20px; }
  .del { display:block; width:100%; background:none; border:0; color:var(--danger); font-size:14px; font-weight:600; padding:11px; cursor:pointer; margin-top:6px; border-radius:11px; }
  .del.confirm { background:color-mix(in srgb,var(--danger) 14%,transparent); }
  .chips { display:flex; flex-wrap:wrap; gap:7px; margin:8px 0 10px; }
  .pchip { border:1px solid var(--line); background:none; color:var(--tx); border-radius:18px; padding:6px 12px; font-size:13px; cursor:pointer; }
  .pchip.sel { background:var(--acc); border-color:var(--acc); color:var(--acc-tx); }
  .run { display:flex; gap:9px; padding:9px 14px; align-items:baseline; border-top:1px solid var(--line); font-size:14px; }
  .run:first-child { border-top:0; }
  .run .t { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .run .w { color:var(--sub); font-size:12px; white-space:nowrap; }
  .run a { color:inherit; text-decoration:none; }
  .hint { color:var(--sub); font-size:12.5px; margin-top:6px; }
  #toast { position:fixed; left:14px; right:14px; bottom:16px; background:#000d; color:#fff; padding:11px 15px;
    border-radius:12px; opacity:0; transition:opacity .25s; pointer-events:none; z-index:9; font-size:14px; text-align:center; }
  .skeleton { color:var(--sub); padding:14px; }
  .refresh { float:right; background:none; border:0; color:var(--acc); font-size:14px; font-weight:600; cursor:pointer; padding:2px 4px; }
</style></head><body>
<h1>🏭 CI-фабрика <button class="refresh" onclick="refresh()">Обновить</button></h1>
<div class="sum" id="summary">загрузка…</div>

<h2>Приложения</h2>
<div id="repos"><div class="card skeleton">⏳ Загружаю список…</div></div>

<h2>Добавить приложение</h2>
<div class="card" style="padding:13px 14px">
  <div class="lbl" style="margin-top:0">Репозиторий на GitHub</div>
  <div class="row"><input id="addSlug" placeholder="owner/repo или ссылка" autocapitalize="none"></div>
  <div class="lbl">Что собирать</div>
  <div class="row">
    <select id="addPlatform">
      <option value="android">Android — APK</option>
      <option value="macos">macOS — приложение</option>
    </select>
    <button class="sbtn" onclick="addRepo()">Добавить</button>
  </div>
  <div class="hint">Первая сборка запустится автоматически на ближайшей проверке — или сразу кнопкой «Собрать сейчас».</div>
</div>

<h2>Расписание проверок</h2>
<div class="card" style="padding:13px 14px">
  <div id="cronHuman" style="font-weight:600">—</div>
  <div class="hint" style="margin-top:2px">Как часто фабрика проверяет репозитории на обновления. Время — UTC.</div>
  <div class="chips" id="cronChips"></div>
  <div class="lbl">Своё cron-выражение</div>
  <div class="row">
    <input id="cron" placeholder="7 5 * * *" autocapitalize="none">
    <button class="sbtn" onclick="saveCron()">Сохранить</button>
  </div>
  <div class="hint">5 полей: минута · час · день · месяц · день недели. Пример: <b>0 8 * * 1</b> — по понедельникам в 08:00.</div>
</div>

<h2>Последние сборки</h2>
<div class="card" id="runs"><div class="skeleton">—</div></div>
<div id="toast"></div>
<script>
const TG = window.Telegram && window.Telegram.WebApp; if (TG) { TG.ready(); TG.expand(); }
let DATA = { repos: [], cron: '' };
let openRepo = null;

function toast(t){ const el=document.getElementById('toast'); el.textContent=t; el.style.opacity=1;
  setTimeout(function(){ el.style.opacity=0; }, 3000); }
function api(action, params){
  return fetch('/api', {method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({initData: (TG && TG.initData) || '', action: action, params: params||{}})})
    .then(function(r){ return r.json(); })
    .then(function(j){ if (!j.ok) throw new Error(j.error || 'ошибка'); return j; });
}
function act(action, params, okMsg){
  return api(action, params).then(function(x){ toast('✅ ' + (okMsg || x.message)); return refresh(); })
    .catch(function(e){ toast('⚠️ ' + e.message); });
}
const escH = function(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
const DOWS = ['воскресеньям','понедельникам','вторникам','средам','четвергам','пятницам','субботам','воскресеньям'];
function two(n){ return (n.length<2?'0':'')+n; }
function cronHuman(c){
  const f = c.trim().split(/\\s+/);
  if (f.length !== 5) return c;
  const m=f[0], h=f[1], dom=f[2], mon=f[3], dow=f[4];
  if (dom==='*' && mon==='*' && /^[0-9]+$/.test(m)) {
    if (dow==='*') {
      if (/^[0-9]+$/.test(h)) return 'Каждый день в ' + two(h) + ':' + two(m) + ' UTC';
      if (/^[0-9]+(,[0-9]+)+$/.test(h)) return 'Каждый день в ' + h.split(',').map(function(x){return two(x)+':'+two(m);}).join(' и ') + ' UTC';
      if (h==='*') return 'Каждый час в :' + two(m);
      var st = h.match(/^\\*\\/([0-9]+)$/); if (st) return 'Каждые ' + st[1] + ' ч (в :' + two(m) + ')';
    } else if (/^[0-7]$/.test(dow) && /^[0-9]+$/.test(h)) {
      return 'По ' + DOWS[+dow] + ' в ' + two(h) + ':' + two(m) + ' UTC';
    }
  }
  return 'По cron-выражению: ' + c;
}
const MODES = [
  { id:'branch',  t:'Каждый коммит',   d:'свежая сборка после каждого изменения кода в ветке' },
  { id:'release', t:'Только релизы',   d:'версии, которые авторы официально пометили как стабильные' },
  { id:'tag',     t:'Новые git-теги',  d:'сборка при появлении нового тега в репозитории' },
];
const PRESETS = [
  { cron:'7 5 * * *',    t:'Раз в день' },
  { cron:'7 5,17 * * *', t:'Дважды в день' },
  { cron:'7 */6 * * *',  t:'Каждые 6 часов' },
  { cron:'7 * * * *',    t:'Каждый час' },
  { cron:'7 5 * * 1',    t:'Раз в неделю' },
];
function ago(iso){
  if (!iso) return '';
  var s = (Date.now() - new Date(iso).getTime())/1000;
  if (s < 90) return 'только что';
  if (s < 5400) return Math.round(s/60) + ' мин назад';
  if (s < 129600) return Math.round(s/3600) + ' ч назад';
  return Math.round(s/86400) + ' дн назад';
}
function el(html){ var d=document.createElement('div'); d.innerHTML=html; return d.firstElementChild; }

function watchLine(r){
  if (r.mode === 'branch') return 'Следит за коммитами в ветке ' + escH(r.branch || '?');
  if (r.mode === 'release') return 'Следит за официальными релизами';
  return 'Следит за новыми тегами';
}
function lastLine(r){
  if (!r.last) return 'Ещё не собиралось';
  var ref = r.last.length > 12 ? r.last.slice(0,7) : r.last;
  return 'Последняя сборка: ' + escH(ref) + (r.at ? ' · ' + ago(r.at) : '');
}

function renderRepos(){
  var box = document.getElementById('repos'); box.innerHTML='';
  if (!DATA.repos.length) { box.appendChild(el('<div class="card skeleton">Пока пусто — добавьте первый репозиторий ниже.</div>')); return; }
  DATA.repos.forEach(function(r){
    var icon = r.platform === 'android' ? '🤖' : '🍏';
    var card = el('<div class="card' + (openRepo===r.name?' open':'') + '">' +
      '<div class="rhead">' +
        '<div class="ricon">' + icon + '</div>' +
        '<div class="rmain">' +
          '<div class="rtitle">' + escH(r.display) +
            ' <span class="chip ' + (r.paused?'off':'on') + '">' + (r.paused?'выключена':'активна') + '</span></div>' +
          '<div class="rsub">' + watchLine(r) + ' · ' + lastLine(r) + '</div>' +
        '</div><div class="chev">▶</div>' +
      '</div>' +
      '<div class="body"></div></div>');
    card.querySelector('.rhead').onclick = function(){ openRepo = (openRepo===r.name?null:r.name); renderRepos(); };
    var body = card.querySelector('.body');

    var build = el('<button class="btn">🔨 Собрать сейчас</button>');
    build.onclick = function(){ build.disabled = true;
      api('build',{name:r.name}).then(function(){ toast('✅ Сборка запущена — результат придёт в канал'); build.disabled=false; })
      .catch(function(e){ toast('⚠️ '+e.message); build.disabled=false; }); };
    body.appendChild(build);

    body.appendChild(el('<div class="lbl" style="margin-top:0">Когда пересобирать</div>'));
    MODES.forEach(function(m){
      var o = el('<div class="opt' + (r.mode===m.id?' sel':'') + '"><div class="tick">' + (r.mode===m.id?'✓':'') + '</div>' +
        '<div><div class="ot">' + m.t + '</div><div class="od">' + m.d + '</div></div></div>');
      o.onclick = function(){ if (r.mode!==m.id) act('setMode',{name:r.name,mode:m.id},'Режим: ' + m.t); };
      body.appendChild(o);
    });

    if (r.mode === 'branch') {
      body.appendChild(el('<div class="lbl">Ветка</div>'));
      var row = el('<div class="row"><input value="' + escH(r.branch||'') + '" autocapitalize="none"><button class="sbtn">Сохранить</button></div>');
      row.querySelector('.sbtn').onclick = function(){
        var v = row.querySelector('input').value.trim();
        if (v && v !== r.branch) act('setBranch',{name:r.name,branch:v});
      };
      body.appendChild(row);
    }

    var swrow = el('<div class="switchrow"><div><div class="ot" style="font-weight:600">Автосборка</div>' +
      '<div class="od" style="color:var(--sub);font-size:12.5px">' + (r.paused?'выключена — репозиторий не проверяется':'включена — собирается при обновлениях') + '</div></div>' +
      '<div class="sw' + (r.paused?'':' on') + '"></div></div>');
    swrow.querySelector('.sw').onclick = function(){ act('pause',{name:r.name}); };
    body.appendChild(swrow);

    var del = el('<button class="del">Удалить из отслеживания</button>');
    var armed = false;
    del.onclick = function(){
      if (!armed) { armed=true; del.textContent='Точно удалить ' + r.display + '? Нажмите ещё раз'; del.classList.add('confirm');
        setTimeout(function(){ armed=false; del.textContent='Удалить из отслеживания'; del.classList.remove('confirm'); }, 4000);
        return; }
      act('remove',{name:r.name});
    };
    body.appendChild(del);
    box.appendChild(card);
  });
}

function renderCron(){
  document.getElementById('cronHuman').textContent = cronHuman(DATA.cron);
  document.getElementById('cron').value = DATA.cron;
  var chips = document.getElementById('cronChips'); chips.innerHTML='';
  PRESETS.forEach(function(p){
    var c = el('<button class="pchip' + (DATA.cron===p.cron?' sel':'') + '">' + p.t + '</button>');
    c.onclick = function(){ act('setCron',{cron:p.cron},'Расписание: ' + p.t.toLowerCase()); };
    chips.appendChild(c);
  });
}

function renderRuns(runs){
  var rb = document.getElementById('runs'); rb.innerHTML='';
  var ic = function(s){ return ({success:'✅',failure:'🔴',cancelled:'⚪️',in_progress:'🔵',queued:'🕐'})[s]||'▫️'; };
  if (!runs.length) { rb.innerHTML = '<div class="skeleton">Сборок ещё не было</div>'; return; }
  runs.forEach(function(w){
    rb.appendChild(el('<div class="run">' + ic(w.state) +
      ' <div class="t"><a href="' + w.url + '" target="_blank">' + escH(w.title) + '</a></div>' +
      '<div class="w">' + ago(w.at) + '</div></div>'));
  });
}

function refresh(){
  return api('list').then(function(d){
    DATA = d;
    var act = d.repos.filter(function(r){return !r.paused;}).length;
    document.getElementById('summary').textContent =
      d.repos.length + ' прил. (' + act + ' активно) · проверка: ' + cronHuman(d.cron).toLowerCase();
    renderRepos(); renderCron();
  }).catch(function(e){
    document.getElementById('repos').innerHTML = '<div class="card skeleton">⚠️ ' + escH(e.message) + '</div>';
  }).then(function(){
    return api('status').then(function(s){ renderRuns(s.runs); }).catch(function(){});
  });
}
function saveCron(){ act('setCron',{cron:document.getElementById('cron').value}); }
function addRepo(){
  var slug = document.getElementById('addSlug').value.trim();
  if (!slug) return toast('Укажите owner/repo');
  toast('Проверяю репозиторий…');
  act('add',{slug:slug, platform:document.getElementById('addPlatform').value})
    .then(function(){ document.getElementById('addSlug').value=''; });
}
refresh();
</script></body></html>`;

// ---------- чат-команды (резерв) ----------
async function onMessage(env, msg) {
  const chat = msg.chat.id;
  const text = (msg.text || '').trim();
  const panelHint = 'Основное управление — кнопка «⚙️ Панель» рядом с полем ввода в личном чате с ботом.';

  if (/^\/(start|help)/.test(text))
    return tg(env, 'sendMessage', { chat_id: chat, text: `🏭 CI-фабрика\n\n${panelHint}\n\nРезервные команды:\n/build имя|all — пересобрать\n/schedule 7 5 * * * — задать cron\n/status — последние сборки\n/list — список приложений` });

  if (text.startsWith('/build')) {
    const name = (text.split(/\s+/)[1] || '').toLowerCase();
    if (!/^[a-z0-9_-]+$|^all$/.test(name))
      return tg(env, 'sendMessage', { chat_id: chat, text: 'Формат: /build имя или /build all' });
    await dispatchBuild(env, name);
    return tg(env, 'sendMessage', { chat_id: chat, text: `🔨 Запустил: ${name}` });
  }

  if (text.startsWith('/schedule')) {
    const cron = text.replace(/^\/schedule\S*\s*/, '').trim();
    if (!cron) return tg(env, 'sendMessage', { chat_id: chat, text: 'Задать: /schedule 7 5 * * * (или через панель — там пресеты и подсказки)' });
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
    const lines = repos.map((r) => `${r.paused ? '⏸' : '🟢'} ${r.display} · ${r.platform} · ${r.mode}${r.branch ? ' @ ' + r.branch : ''}`);
    return tg(env, 'sendMessage', { chat_id: chat, text: `${lines.join('\n')}\n\n${panelHint}` });
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
          { command: 'list', description: 'Список приложений' },
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
