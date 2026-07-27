// Telegram-бот управления CI-фабрикой (Cloudflare Worker).
// Правит config.yaml / check.yml в GitHub через Contents API и запускает сборки
// через workflow_dispatch. Состояний не хранит: контекст диалога кодируется в
// тексте сообщений (ForceReply / текст над кнопками).

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

const tg = (env, method, body) =>
  fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const gh = async (env, path, init = {}) => {
  const r = await fetch('https://api.github.com' + path, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'user-agent': 'ci-factory-bot',
      accept: 'application/vnd.github+json',
      ...(init.headers || {}),
    },
  });
  return r;
};

async function getFile(env, path) {
  const r = await gh(env, `/repos/${REPO}/contents/${path}?ref=main`);
  if (!r.ok) throw new Error(`GitHub GET ${path}: ${r.status}`);
  const j = await r.json();
  return { text: b64dec(j.content), sha: j.sha };
}

async function putFile(env, path, text, sha, message) {
  const body = { message: `bot: ${message}`, content: b64enc(text), sha, branch: 'main' };
  let r = await gh(env, `/repos/${REPO}/contents/${path}`, { method: 'PUT', body: JSON.stringify(body) });
  if (r.status === 409 || r.status === 422) {
    // sha устарел (гонка со state-коммитом) — перечитать и повторить один раз
    const fresh = await getFile(env, path);
    body.sha = fresh.sha;
    r = await gh(env, `/repos/${REPO}/contents/${path}`, { method: 'PUT', body: JSON.stringify(body) });
  }
  if (!r.ok) throw new Error(`GitHub PUT ${path}: ${r.status} ${await r.text()}`);
}

// ---------- config.yaml: блочные операции (канонический формат, комментарии сохраняются) ----------
function parseConfig(text) {
  const lines = text.split('\n');
  const blocks = [];
  let header = [];
  let cur = null;
  for (const line of lines) {
    if (/^  - name: /.test(line)) {
      if (cur) blocks.push(cur);
      cur = { name: line.replace(/^  - name: /, '').trim(), lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      header.push(line);
    }
  }
  if (cur) blocks.push(cur);
  return { header: header.join('\n'), blocks };
}
const renderConfig = (cfg) =>
  (cfg.header.replace(/\n+$/, '') + '\n\n' + cfg.blocks.map((b) => b.lines.join('\n').replace(/\n+$/, '')).join('\n\n')).replace(/\n*$/, '\n');

const bGet = (block, re, dflt = '') => {
  const m = block.lines.join('\n').match(re);
  return m ? m[1].trim() : dflt;
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
  if (re.test(joined)) {
    block.lines = joined.replace(re, replacement).split('\n');
  } else if (insertAfterRe) {
    const i = block.lines.findIndex((l) => insertAfterRe.test(l));
    block.lines.splice(i + 1, 0, replacement);
  }
}

// ---------- шаблоны блоков ----------
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

// ---------- представление ----------
const kbList = (blocks) => ({
  inline_keyboard: blocks
    .map((b) => info(b))
    .map((i) => [{ text: `${i.paused ? '⏸' : '🟢'} ${i.display} · ${i.platform}`, callback_data: `m|${i.name}` }]),
});

const kbMenu = (i) => ({
  inline_keyboard: [
    [{ text: '🔨 Собрать сейчас', callback_data: `b|${i.name}` }],
    [
      { text: i.paused ? '▶️ Возобновить' : '⏸ Пауза', callback_data: `p|${i.name}` },
      { text: `🔁 Триггер: ${i.mode}`, callback_data: `tr|${i.name}` },
    ],
    [
      { text: `🌿 Ветка: ${i.branch || '—'}`, callback_data: `br|${i.name}` },
      { text: '🗑 Удалить', callback_data: `d|${i.name}` },
    ],
    [{ text: '⬅️ К списку', callback_data: 'ls' }],
  ],
});

const menuText = (i) =>
  `<b>${esc(i.display)}</b>  (<code>${esc(i.name)}</code>)\n` +
  `${esc(i.slug)} · ${i.platform} · ${i.mode}${i.branch ? ' @ ' + esc(i.branch) : ''}` +
  (i.paused ? '\n⏸ <b>на паузе</b>' : '');

const SCHEDULES = {
  d1: { cron: '7 5 * * *', label: '1 раз в день (05:07 UTC)' },
  d2: { cron: '7 5,17 * * *', label: '2 раза в день (05:07, 17:07 UTC)' },
  h6: { cron: '7 */6 * * *', label: 'каждые 6 часов' },
  h1: { cron: '7 * * * *', label: 'каждый час' },
  w1: { cron: '7 5 * * 1', label: 'раз в неделю (пн 05:07 UTC)' },
};

// ---------- обработчики ----------
async function cmdList(env, chat) {
  const { text } = await getFile(env, 'config.yaml');
  const cfg = parseConfig(text);
  if (!cfg.blocks.length) return tg(env, 'sendMessage', { chat_id: chat, text: 'Репозиториев нет. /add owner/repo' });
  return tg(env, 'sendMessage', {
    chat_id: chat,
    text: '📦 Отслеживаемые репозитории:',
    reply_markup: kbList(cfg.blocks),
  });
}

async function cmdStatus(env, chat) {
  const r = await gh(env, `/repos/${REPO}/actions/runs?per_page=8`);
  const j = await r.json();
  const icon = (c) => ({ success: '✅', failure: '🔴', cancelled: '⚪️' }[c] || '🔵');
  const rows = j.workflow_runs.map((w) => `${icon(w.conclusion || w.status)} <a href="${w.html_url}">${esc(w.display_title)}</a>`);
  return tg(env, 'sendMessage', {
    chat_id: chat, text: rows.join('\n') || 'Запусков нет', parse_mode: 'HTML', disable_web_page_preview: true,
  });
}

async function cmdSchedule(env, chat) {
  const { text } = await getFile(env, '.github/workflows/check.yml');
  const cur = (text.match(/cron: '([^']+)'/) || [])[1] || '?';
  const found = Object.values(SCHEDULES).find((s) => s.cron === cur);
  return tg(env, 'sendMessage', {
    chat_id: chat,
    text: `🕐 Сейчас: <code>${esc(cur)}</code>${found ? ` — ${found.label}` : ''}\nВыберите новое расписание:`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: Object.entries(SCHEDULES).map(([id, s]) => [{ text: s.label, callback_data: `s|${id}` }]) },
  });
}

async function dispatchBuild(env, name) {
  const r = await gh(env, `/repos/${REPO}/actions/workflows/check.yml/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: 'main', inputs: { force: name } }),
  });
  if (r.status !== 204) throw new Error(`dispatch: ${r.status} ${await r.text()}`);
}

async function onMessage(env, msg) {
  const chat = msg.chat.id;
  const text = (msg.text || '').trim();

  // ответ на ForceReply «новая ветка»
  const rt = msg.reply_to_message?.text || '';
  const mBr = rt.match(/^✏️ Ветка для ([a-z0-9_-]+)\./);
  if (mBr) {
    const branch = text.split(/\s/)[0];
    if (!/^[\w./-]+$/.test(branch)) return tg(env, 'sendMessage', { chat_id: chat, text: 'Некорректное имя ветки' });
    const f = await getFile(env, 'config.yaml');
    const cfg = parseConfig(f.text);
    const b = cfg.blocks.find((x) => x.name === mBr[1]);
    if (!b) return tg(env, 'sendMessage', { chat_id: chat, text: 'Репозиторий не найден' });
    bSet(b, /^ {6}branch: .*$/m, `      branch: ${branch}`);
    await putFile(env, 'config.yaml', renderConfig(cfg), f.sha, `${mBr[1]}: branch -> ${branch}`);
    return tg(env, 'sendMessage', { chat_id: chat, text: `✅ ${mBr[1]}: ветка теперь ${branch}` });
  }

  if (text.startsWith('/start') || text.startsWith('/help')) {
    return tg(env, 'sendMessage', {
      chat_id: chat,
      text:
        '🏭 Пульт CI-фабрики\n\n' +
        '/list — репозитории и управление (кнопки)\n' +
        '/add owner/repo — добавить репозиторий\n' +
        '/build имя|all — пересобрать сейчас\n' +
        '/schedule — расписание проверок\n' +
        '/status — последние сборки\n\n' +
        'Артефакты приходят в канал автоматически после каждого обновления в отслеживаемых репо.',
    });
  }

  if (text.startsWith('/list')) return cmdList(env, chat);
  if (text.startsWith('/status')) return cmdStatus(env, chat);
  if (text.startsWith('/schedule')) return cmdSchedule(env, chat);

  if (text.startsWith('/build')) {
    const name = (text.split(/\s+/)[1] || '').toLowerCase();
    if (!/^[a-z0-9_-]+$|^all$/.test(name))
      return tg(env, 'sendMessage', { chat_id: chat, text: 'Формат: /build имя (из /list) или /build all' });
    await dispatchBuild(env, name);
    return tg(env, 'sendMessage', { chat_id: chat, text: `🔨 Запустил проверку и сборку: ${name}` });
  }

  if (text.startsWith('/add')) {
    const slug = (text.split(/\s+/)[1] || '').replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(slug))
      return tg(env, 'sendMessage', { chat_id: chat, text: 'Формат: /add owner/repo (или ссылка на GitHub)' });
    const r = await gh(env, `/repos/${slug}`);
    if (!r.ok) return tg(env, 'sendMessage', { chat_id: chat, text: `Не нашёл репозиторий ${slug} (${r.status})` });
    return tg(env, 'sendMessage', {
      chat_id: chat,
      text: `Платформа для ${slug}?`,
      reply_markup: {
        inline_keyboard: [[
          { text: '🤖 Android APK', callback_data: 'ap|android' },
          { text: '🍏 macOS app', callback_data: 'ap|macos' },
        ]],
      },
    });
  }

  return tg(env, 'sendMessage', { chat_id: chat, text: 'Не понял. /help' });
}

async function onCallback(env, cq) {
  const chat = cq.message.chat.id;
  const [act, arg] = (cq.data || '').split('|');
  const ack = (t) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: t || '' });

  if (act === 'ls') {
    await ack();
    const { text } = await getFile(env, 'config.yaml');
    return tg(env, 'editMessageText', {
      chat_id: chat, message_id: cq.message.message_id,
      text: '📦 Отслеживаемые репозитории:', reply_markup: kbList(parseConfig(text).blocks),
    });
  }

  if (act === 'ap') {
    const slug = (cq.message.text.match(/для ([\w.-]+\/[\w.-]+)\?/) || [])[1];
    if (!slug) return ack('Не нашёл repo в сообщении');
    const meta = await (await gh(env, `/repos/${slug}`)).json();
    const f = await getFile(env, 'config.yaml');
    const cfg = parseConfig(f.text);
    let name = slug.split('/')[1].toLowerCase().replace(/[^a-z0-9_-]/g, '');
    while (cfg.blocks.some((b) => b.name === name)) name += '2';
    const display = slug.split('/')[1];
    const branch = meta.default_branch || 'main';
    const tpl = arg === 'android' ? tplAndroid : tplMacos;
    cfg.blocks.push({ name, lines: tpl(name, slug, display, branch).split('\n') });
    await putFile(env, 'config.yaml', renderConfig(cfg), f.sha, `add ${name} (${arg})`);
    await ack('Добавлено');
    return tg(env, 'editMessageText', {
      chat_id: chat, message_id: cq.message.message_id,
      text:
        `✅ Добавил ${slug} (${arg}), ветка ${branch}.\n` +
        (arg === 'macos'
          ? '⚠️ Впишите project/scheme/product в config.yaml (в шаблоне CHECK_ME) — для xcode-проектов они у всех свои.\n'
          : '⚠️ Шаблон рассчитан на стандартный gradle-проект (модуль app, assembleRelease) — если сборка упадёт, 🔴 придёт в канал.\n') +
        `Собрать сейчас: /build ${name}`,
    });
  }

  // все остальные действия — над существующим блоком
  const f = await getFile(env, 'config.yaml');
  const cfg = parseConfig(f.text);
  const b = cfg.blocks.find((x) => x.name === arg);
  if (!b) return ack('Уже удалён?');
  const i = info(b);

  if (act === 'm') {
    await ack();
    return tg(env, 'editMessageText', {
      chat_id: chat, message_id: cq.message.message_id,
      text: menuText(i), parse_mode: 'HTML', reply_markup: kbMenu(i),
    });
  }
  if (act === 'b') {
    await dispatchBuild(env, i.name);
    return ack('🔨 Запустил');
  }
  if (act === 'p') {
    if (i.paused) {
      b.lines = b.lines.filter((l) => !/^ {4}paused: /.test(l));
    } else {
      bSet(b, /^ {4}paused: .*$/m, '    paused: true', /^ {4}platform: /);
    }
    await putFile(env, 'config.yaml', renderConfig(cfg), f.sha, `${i.name}: paused=${!i.paused}`);
    const ni = { ...i, paused: !i.paused };
    await ack(ni.paused ? '⏸ Пауза' : '▶️ Возобновлён');
    return tg(env, 'editMessageText', {
      chat_id: chat, message_id: cq.message.message_id,
      text: menuText(ni), parse_mode: 'HTML', reply_markup: kbMenu(ni),
    });
  }
  if (act === 'tr') {
    const mode = i.mode === 'branch' ? 'release' : 'branch';
    bSet(b, /^( {6})mode: .*$/m, `      mode: ${mode}`);
    await putFile(env, 'config.yaml', renderConfig(cfg), f.sha, `${i.name}: mode -> ${mode}`);
    const ni = { ...i, mode };
    await ack(`Триггер: ${mode}`);
    return tg(env, 'editMessageText', {
      chat_id: chat, message_id: cq.message.message_id,
      text: menuText(ni), parse_mode: 'HTML', reply_markup: kbMenu(ni),
    });
  }
  if (act === 'br') {
    await ack();
    return tg(env, 'sendMessage', {
      chat_id: chat,
      text: `✏️ Ветка для ${i.name}. Ответьте на ЭТО сообщение названием ветки (сейчас: ${i.branch || '—'})`,
      reply_markup: { force_reply: true },
    });
  }
  if (act === 'd') {
    await ack();
    return tg(env, 'editMessageText', {
      chat_id: chat, message_id: cq.message.message_id,
      text: `Удалить <b>${esc(i.display)}</b> из отслеживания? (историю сборок и артефакты в канале это не трогает)`,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[
        { text: '❌ Да, удалить', callback_data: `dc|${i.name}` },
        { text: '⬅️ Отмена', callback_data: `m|${i.name}` },
      ]] },
    });
  }
  if (act === 'dc') {
    cfg.blocks = cfg.blocks.filter((x) => x.name !== i.name);
    await putFile(env, 'config.yaml', renderConfig(cfg), f.sha, `remove ${i.name}`);
    await ack('Удалено');
    return tg(env, 'editMessageText', {
      chat_id: chat, message_id: cq.message.message_id,
      text: `🗑 ${esc(i.display)} больше не отслеживается.`, parse_mode: 'HTML',
    });
  }
  return ack();
}

async function onSchedule(env, cq) {
  const preset = SCHEDULES[cq.data.split('|')[1]];
  if (!preset) return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const f = await getFile(env, '.github/workflows/check.yml');
  const updated = f.text.replace(/cron: '[^']*'/, `cron: '${preset.cron}'`);
  await putFile(env, '.github/workflows/check.yml', updated, f.sha, `schedule -> ${preset.cron}`);
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Сохранено' });
  return tg(env, 'editMessageText', {
    chat_id: cq.message.chat.id, message_id: cq.message.message_id,
    text: `🕐 Новое расписание: ${preset.label} (<code>${preset.cron}</code>)`, parse_mode: 'HTML',
  });
}

// ---------- вход ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/setup' && url.searchParams.get('key') === env.WEBHOOK_SECRET) {
      const wh = await tg(env, 'setWebhook', {
        url: `${url.origin}/tg`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true,
      });
      const cmds = await tg(env, 'setMyCommands', {
        commands: [
          { command: 'list', description: 'Репозитории и управление' },
          { command: 'add', description: 'Добавить: /add owner/repo' },
          { command: 'build', description: 'Пересобрать: /build имя|all' },
          { command: 'schedule', description: 'Расписание проверок' },
          { command: 'status', description: 'Последние сборки' },
          { command: 'help', description: 'Справка' },
        ],
      });
      return Response.json({ webhook: wh, commands: cmds });
    }

    if (url.pathname === '/tg' && request.method === 'POST') {
      if (request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET)
        return new Response('forbidden', { status: 403 });
      const update = await request.json();
      const from = update.message?.from?.id ?? update.callback_query?.from?.id;
      if (String(from) !== String(env.ALLOWED_USER_ID)) {
        if (update.callback_query)
          await tg(env, 'answerCallbackQuery', { callback_query_id: update.callback_query.id, text: '⛔' });
        return new Response('ok'); // чужих молча игнорируем
      }
      try {
        if (update.message) await onMessage(env, update.message);
        else if (update.callback_query) {
          if (update.callback_query.data?.startsWith('s|')) await onSchedule(env, update.callback_query);
          else await onCallback(env, update.callback_query);
        }
      } catch (e) {
        const chat = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
        if (chat) await tg(env, 'sendMessage', { chat_id: chat, text: `⚠️ Ошибка: ${String(e).slice(0, 300)}` });
      }
      return new Response('ok');
    }

    return new Response('ci-factory bot', { status: 200 });
  },
};
