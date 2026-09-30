/**
 * browser and cdp — the user's own browser through the Hanzo extension, over
 * this user's ZAP router (`../zap.ts`), with headless Playwright as the
 * fallback when no browser is registered.
 *
 * The same surface as python-sdk `hanzo_tools.browser` and the Rust runtime:
 * the same action names, the core parameters typed and the rest in `args`, the
 * same extension methods. ACTIONS is the one table that names, routes and
 * documents every action.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { Tool, ToolResult } from '../types/index.js';
import * as zap from '../zap.js';

/** name → [topic, usage, extension method (null: Playwright only), hanzo.act op]. */
type Op = [string, string, string | null, string?];

export const ACTIONS: Record<string, Op> = {
  // core: the default surface, and the loop an agent drives a page with
  navigate: ['core', 'url: open a URL; returns once it has loaded', 'hanzo.navigate'],
  snapshot: ['core', '[interactive] [compact] [depth] [selector] [args.urls]: the accessibility tree, [ref=eN] on every node you can act on', 'hanzo.snapshot'],
  click: ['core', 'selector: click a ref (@e2) or CSS selector; refused when another element covers it', 'hanzo.act', 'click'],
  fill: ['core', "selector, text: replace a field's value", 'hanzo.act', 'fill'],
  type: ['core', 'text [selector]: type key by key into the element, or the focused one', 'hanzo.act', 'type'],
  press: ['core', 'key [selector]: Enter, Tab, Escape, ArrowDown, Control+a', 'hanzo.act', 'press'],
  read: ['core', '[outline] [filter]: the page as markdown, as the signed-in user sees it', 'hanzo.read'],
  screenshot: ['core', '[annotate] [args.full_page] [args.full_res] [args.path]: the viewport, downscaled unless full_res; annotate boxes each ref, label [N] = @eN, and returns the legend', 'hanzo.screenshot'],
  evaluate: ['core', 'code: run JavaScript in the page and return its value', 'Runtime.evaluate'],
  wait: ['core', 'selector | text [args.state=hidden] | timeout: until it shows (or goes), or for ms', 'hanzo.wait'],
  tabs: ['core', 'open tabs; tab_id targets one in any action', 'Target.getTargets'],
  help: ['core', '[topic]: every other action, with how to call it', null],
  // interact: more ways to act on a ref or CSS selector
  dblclick: ['interact', 'selector', 'hanzo.act', 'dblclick'],
  hover: ['interact', 'selector', 'hanzo.act', 'hover'],
  focus: ['interact', 'selector', 'hanzo.act', 'focus'],
  select: ['interact', 'selector, args.value: choose a <select> option by value or label', 'hanzo.act', 'select'],
  check: ['interact', 'selector: check a checkbox or radio (no-op when already checked)', 'hanzo.act', 'check'],
  uncheck: ['interact', 'selector', 'hanzo.act', 'uncheck'],
  scroll: ['interact', 'args.delta_x, args.delta_y [selector]: scroll the page, or an element, by pixels', 'hanzo.act', 'scroll'],
  scroll_into_view: ['interact', 'selector', 'hanzo.act', 'scrollIntoView'],
  get_text: ['interact', "selector: rendered text; a field's value", 'hanzo.act', 'text'],
  get_attribute: ['interact', 'selector, args.attribute', 'hanzo.act', 'attribute'],
  count: ['interact', 'selector: how many elements a CSS selector matches', 'hanzo.act', 'count'],
  upload: ['interact', "selector, args.files: set a file input's files", null],
  drag: ['interact', 'selector, args.target_selector', null],
  blur: ['interact', 'selector', null],
  tap: ['interact', 'selector: a touch tap', null],
  swipe: ['interact', 'selector, args.direction [args.distance]', null],
  pinch: ['interact', 'selector [args.scale]', null],
  mouse_move: ['interact', 'args.x, args.y', null],
  mouse_down: ['interact', '[args.button]', null],
  mouse_up: ['interact', '[args.button]', null],
  // navigation
  go_back: ['navigation', 'back one page', 'Page.goBack'],
  go_forward: ['navigation', 'forward one page', 'Page.goForward'],
  reload: ['navigation', 'reload the page', 'Page.reload'],
  url: ['navigation', "the tab's URL", 'hanzo.url'],
  title: ['navigation', "the tab's title", 'hanzo.title'],
  set_content: ['navigation', "args.html: replace the page's HTML", null],
  // tabs and browsers
  new_tab: ['tabs', '[url]: open a tab', 'Target.createTarget'],
  close_tab: ['tabs', 'tab_id (Playwright: args.tab_index)', 'Target.closeTarget'],
  select_tab: ['tabs', 'tab_id (Playwright: args.tab_index): bring a tab to the front', 'Target.activateTarget'],
  browsers: ['tabs', 'connected browsers; target_browser picks one', null],
  status: ['tabs', 'the browser behind this tool', 'Browser.getVersion'],
  close: ['tabs', 'close the Playwright browser', null],
  new_context: ['tabs', '[url] [args.device]: an isolated Playwright session (own cookies and storage)', null],
  connect: ['tabs', 'args.cdp_endpoint: attach Playwright to a running Chrome', null],
  set_headless: ['tabs', '[args.headless]: relaunch Playwright headed or headless', null],
  // page: content and state
  get_html: ['page', "[selector]: an element's HTML, or the page's", 'hanzo.getHTML'],
  get_bounding_box: ['page', 'selector', null],
  pdf: ['page', '[args.path]: print the page to PDF', null],
  is_visible: ['page', 'selector', null],
  is_enabled: ['page', 'selector', null],
  is_editable: ['page', 'selector', null],
  is_checked: ['page', 'selector', null],
  highlight: ['page', 'selector: outline an element on screen', null],
  // assert: fail unless the page matches (args.not_ negates)
  expect_visible: ['assert', 'selector', null],
  expect_hidden: ['assert', 'selector', null],
  expect_enabled: ['assert', 'selector', null],
  expect_checked: ['assert', 'selector', null],
  expect_text: ['assert', 'selector, args.expected', null],
  expect_value: ['assert', 'selector, args.expected', null],
  expect_attribute: ['assert', 'selector, args.attribute, args.expected', null],
  expect_count: ['assert', 'selector, args.index (the count)', null],
  expect_url: ['assert', 'args.expected (glob with *)', null],
  expect_title: ['assert', 'args.expected (glob with *)', null],
  // storage
  cookies: ['storage', "the page's cookies (Playwright: args.cookies sets them)", 'hanzo.getCookies'],
  clear_cookies: ['storage', 'delete every cookie', null],
  storage: ['storage', '[args.storage_type=local|session] [args.storage_data]: read or write web storage', null],
  storage_state: ['storage', 'args.auth_file: save cookies and storage there, or load them when it exists', null],
  // network
  route: ['network', 'args.pattern [args.block] [args.response] [args.status_code]: block or mock requests', null],
  unroute: ['network', 'args.pattern', null],
  wait_for_request: ['network', 'args.pattern', null],
  wait_for_response: ['network', 'args.pattern', null],
  // emulation
  viewport: ['emulation', '[args.width, args.height]: read or set the viewport', null],
  emulate: ['emulation', 'args.device: mobile, tablet, laptop, iphone_14, pixel_7, ipad_pro …', null],
  geolocation: ['emulation', 'args.latitude, args.longitude', null],
  permissions: ['emulation', 'args.permission: grant it', null],
  // debug and events
  console: ['debug', "[args.level]: the page's console messages", null],
  errors: ['debug', 'uncaught page errors', null],
  dialog: ['debug', '[args.accept] [args.prompt_text]: answer a pending alert/confirm/prompt', null],
  file_chooser: ['debug', '[args.files]: answer a pending file chooser', null],
  download: ['debug', '[selector]: the pending download, or click selector and take its download', null],
  wait_for_load: ['debug', '[args.state=load|domcontentloaded|networkidle]', null],
  wait_for_url: ['debug', 'args.pattern', null],
  wait_for_function: ['debug', 'code: until the JavaScript returns truthy', null],
  wait_for_event: ['debug', 'args.event: request, response, download, filechooser, popup', null],
  trace_start: ['debug', 'record a Playwright trace', null],
  trace_stop: ['debug', '[args.trace_path]', null],
};

const CORE = Object.keys(ACTIONS).filter((a) => ACTIONS[a][0] === 'core');
const TOPICS = [...new Set(Object.values(ACTIONS).map((o) => o[0]))];
/** The extension's page engine answers these as JSON the tool unpacks. */
const ENGINE = new Set(['hanzo.navigate', 'hanzo.snapshot', 'hanzo.read', 'hanzo.act', 'hanzo.wait']);
const TYPED = ['action', 'selector', 'url', 'text', 'key', 'code', 'interactive', 'compact', 'depth', 'outline',
  'filter', 'annotate', 'timeout', 'tab_id', 'target_browser', 'topic'];
/** What `args` may carry: every parameter the schema does not type. */
const ARGS = new Set(['target_selector', 'value', 'html', 'attribute', 'urls', 'index', 'files', 'x', 'y', 'button',
  'delta_x', 'delta_y', 'direction', 'distance', 'scale', 'width', 'height', 'device', 'latitude', 'longitude',
  'accuracy', 'permission', 'pattern', 'response', 'status_code', 'block', 'state', 'event', 'expected', 'not_',
  'full_page', 'path', 'max_width', 'quality', 'full_res', 'tab_index', 'client_id', 'cdp_endpoint', 'headless',
  'cookies', 'storage_type', 'storage_data', 'auth_file', 'accept', 'prompt_text', 'frame', 'trace_path', 'level']);
const REF = /^@?e\d+$/;

const LOOP = `The loop: snapshot, act on refs, snapshot again when the page changes.
  browser(action="navigate", url="https://example.com")
  browser(action="snapshot", interactive=true)     - button "Sign in" [ref=e2]
  browser(action="click", selector="@e2")
  browser(action="fill", selector="@e3", text="me@example.com")
  browser(action="press", key="Enter")
  browser(action="read", filter="pricing")         the page as markdown
  browser(action="screenshot", annotate=true)      labels [N] on the image = @eN
A ref stays valid while its element is on the page, across snapshots. After a
navigation, or when an element was removed, the ref is refused: snapshot again.
A click on an element covered by a consent banner, modal or overlay is refused
and names the cover: act on the cover, then snapshot again.
selector takes a ref (@e2) or a CSS selector. Parameters outside the core
schema go in args, e.g. browser(action="select", selector="@e4", args={"value": "Weekly"}).`;

const DESCRIPTION = `Drive a browser: the user's own, signed in, through the Hanzo extension (headless Playwright when none is connected).

Loop: snapshot, act on a ref, snapshot again when the page changes.
  snapshot interactive=true        - button "Sign in" [ref=e2]
  click selector="@e2"   fill selector="@e3" text="me@x.com"   press key="Enter"
  read                             the page as markdown (outline=true, filter="…")
  screenshot annotate=true         every ref boxed, label [N] = @eN
selector takes a ref (@e2) or a CSS selector. A stale ref, or a click on an
element under a banner or modal, is refused with what to do next.

action="help" lists everything else (hover, select, check, scroll, back, cookies,
network, emulation, assertions …); their parameters go in args.`;

/** The loop, then every action past the core by topic; `topic` narrows it to one. */
export function help(topic?: string): string {
  if (topic && !TOPICS.includes(topic)) return `No topic "${topic}". Topics: ${TOPICS.join(', ')}.`;
  const lines = topic ? [] : [LOOP, ''];
  for (const t of topic ? [topic] : TOPICS.slice(1)) {
    lines.push(t);
    for (const [name, [tp, usage, wire]] of Object.entries(ACTIONS)) {
      if (tp !== t) continue;
      const only = wire || name === 'help' || name === 'browsers' ? '' : '  (Playwright)';
      lines.push(`  ${name.padEnd(18)}${usage}${only}`.trimEnd());
    }
  }
  lines.push('', '(Playwright): headless Playwright only, not the connected browser.');
  lines.push(`browser(action="help", topic="…") shows one of: ${TOPICS.join(', ')}.`);
  return lines.join('\n');
}

/** BROWSER_BACKEND, else ~/.hanzo/extension/config.json .backend, else auto. */
export function backend(): string {
  const ok = ['firefox', 'chrome', 'extension', 'playwright', 'auto'];
  const pick = (s: unknown) => (typeof s === 'string' && ok.includes(s.trim().toLowerCase()) ? s.trim().toLowerCase() : null);
  const env = pick(process.env.BROWSER_BACKEND);
  if (env) return env;
  try {
    return pick(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.hanzo/extension/config.json'), 'utf8')).backend) ?? 'auto';
  } catch {
    return 'auto';
  }
}

/** A value as the wire carries it: a string, a flag "true", structure as JSON. */
const wireValue = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/** The wire params for `action` (`annotate`: a labelled screenshot), peer of python-sdk `_zap_params`. */
export function wireParams(action: string, a: Record<string, any>, selector: string | undefined, op?: string): Record<string, string> {
  const p: Record<string, string> = {};
  if (action === 'screenshot' || action === 'annotate') {
    p.format = a.full_res ? 'png' : 'jpeg';
    p.quality = String(a.quality ?? 70);
    if (!a.full_res) p.maxWidth = String(a.max_width ?? 1280);
  }
  if (a.url != null) p.url = a.url;
  if (selector != null) p.selector = selector;
  if (a.value != null) p.value = wireValue(a.value);
  if (a.text != null) p.text = a.text;
  if (a.code != null) p.expression = a.code;
  if (a.full_page) p.fullPage = 'true';
  if (a.tab_id != null) p.tabId = String(a.tab_id).replace(/^tab-/, '');
  if (op) p.op = op;
  const names: Record<string, string> = { delta_x: 'dx', delta_y: 'dy' };
  for (const k of ['key', 'index', 'tab_index', 'timeout', 'state', 'level', 'attribute', 'interactive', 'compact',
    'depth', 'urls', 'outline', 'filter', 'delta_x', 'delta_y']) {
    const v = a[k];
    if (v == null || v === false) continue;
    p[names[k] ?? k] = wireValue(v);
  }
  return p;
}

/** Pull the base64 payload out of a screenshot answer. */
export function extractB64(text: string): string | null {
  const t = text.trim();
  const strip = (v: string) => (v.startsWith('data:') ? v.slice(v.indexOf(',') + 1) : v);
  if (t.startsWith('{')) {
    let o: any;
    try { o = JSON.parse(t); } catch { return null; }
    for (const src of [o, o?.result]) {
      for (const k of ['data', 'base64', 'screenshot']) {
        if (typeof src?.[k] === 'string' && src[k]) return strip(src[k]);
      }
    }
    return null;
  }
  if (t.startsWith('data:image')) return strip(t);
  return t.length > 100 && /^[A-Za-z0-9+/=\r\n]+$/.test(t.slice(0, 256)) ? t : null;
}

const text = (v: unknown, isError = false): ToolResult => ({
  content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
  ...(isError ? { isError } : {}),
});

/** A capture goes to a file and comes back as pixels, never as base64 in the text. */
function capture(raw: Buffer, meta: Record<string, unknown>, file?: string): ToolResult {
  const fmt = raw[0] === 0xff && raw[1] === 0xd8 ? 'jpeg' : 'png';
  const target = file
    ? file.replace(/^~(?=$|\/)/, os.homedir())
    : path.join(os.homedir(), '.hanzo', 'screenshots', `capture-${randomBytes(6).toString('hex')}.${fmt}`);
  const out: Record<string, unknown> = { success: true, format: fmt, size: raw.length, ...meta };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, raw);
    out.path = target;
  } catch (e: any) {
    out.note = `not saved: ${e.message}`;
  }
  return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }, { type: 'image', data: raw.toString('base64'), mimeType: `image/${fmt}` }] };
}

/** The extension's reply as the tool's: a refusal is an error, a tree or a page is text. */
function answer(action: string, method: string, provider: string, reply: string): ToolResult {
  if (reply.startsWith('ERR:')) return text({ error: reply.slice(4), action }, true);
  if (ENGINE.has(method)) {
    try {
      const d = JSON.parse(reply);
      if (action === 'snapshot') return text(`${d.title} — ${d.url} (${d.refs} refs)\n${d.tree}`);
      if (action === 'read') return text(`${d.title} — ${d.url}\n\n${d.markdown}`);
      return text({ success: true, ...d });
    } catch { /* not the engine's JSON: pass it through */ }
  }
  return text({ success: true, source: 'extension', transport: 'native-zap', provider, result: reply });
}

/** Route one action to the browser on the router. Throws on a transport
 *  failure (no router, no browser, no answer), which may fall back. */
async function viaExtension(action: string, a: Record<string, any>, filter: string | null, annotate: boolean): Promise<ToolResult> {
  const [, , method, op] = ACTIONS[action];
  const provider = await zap.resolve(filter, a.client_id);
  if (!provider) throw new Error(UNPAIRED);
  const [wire, m] = annotate ? ['annotate', 'hanzo.annotate'] : [action, method!];
  const selector = a.selector ?? (action === 'get_html' ? 'html' : undefined);
  const reply = await zap.route(provider, m, wireParams(wire, a, selector, op));
  if (action === 'screenshot' && !reply.startsWith('ERR:')) {
    const b64 = extractB64(reply);
    if (b64) {
      const meta: Record<string, unknown> = { transport: 'native-zap', provider };
      if (annotate) { try { meta.legend = JSON.parse(reply).legend ?? []; } catch { meta.legend = []; } }
      return capture(Buffer.from(b64, 'base64'), meta, a.path);
    }
  }
  return answer(action, m, provider, reply);
}

export const UNPAIRED = 'no browser on the ZAP router: open Chrome with the Hanzo extension (1.9.59+); it joins on its own. ' +
  'A sandboxed browser (snap, Flatpak) pairs instead: `hanzo-mcp pair` (Python or Rust), then paste the code into the extension\'s popup';

// ── Headless Playwright, when no browser is registered ─────────────────────
let pw: { browser: any; context: any; page: any } | null = null;

async function page(): Promise<any> {
  if (pw?.page && !pw.page.isClosed()) return pw.page;
  let chromium: any;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('No browser: the Hanzo extension is not connected and Playwright is not installed. ' +
      'Connect the extension, or: npm i playwright && npx playwright install chromium');
  }
  const browser = pw?.browser ?? await chromium.launch({ headless: true });
  const context = pw?.context ?? await browser.newContext({ viewport: { width: 1440, height: 900 } });
  pw = { browser, context, page: context.pages()[0] ?? await context.newPage() };
  return pw.page;
}

async function viaPlaywright(action: string, a: Record<string, any>): Promise<ToolResult> {
  if (action === 'close') { await pw?.browser?.close(); pw = null; return text({ success: true, closed: true }); }
  if (action === 'status') return text({ success: true, source: 'playwright', running: !!pw });
  const p = await page();
  const sel: string | undefined = a.selector;
  const timeout = a.timeout ?? 30_000;
  const need = () => { if (!sel) throw new Error('selector required'); return p.locator(sel); };
  const pages = () => pw!.context.pages();
  switch (action) {
    case 'navigate': {
      if (!a.url) return text({ error: 'url required' }, true);
      const r = await p.goto(a.url, { timeout, waitUntil: a.state ?? 'domcontentloaded' });
      return text({ success: true, url: p.url(), title: await p.title(), status: r?.status() ?? null });
    }
    case 'click': await need().click({ timeout }); break;
    case 'dblclick': await need().dblclick({ timeout }); break;
    case 'hover': await need().hover({ timeout }); break;
    case 'focus': await need().focus({ timeout }); break;
    case 'check': await need().check({ timeout }); break;
    case 'uncheck': await need().uncheck({ timeout }); break;
    case 'fill': await need().fill(a.text ?? '', { timeout }); break;
    case 'type': sel ? await need().pressSequentially(a.text ?? '', { timeout }) : await p.keyboard.type(a.text ?? ''); break;
    case 'press': sel ? await need().press(a.key ?? 'Enter', { timeout }) : await p.keyboard.press(a.key ?? 'Enter'); break;
    case 'select': return text({ success: true, selected: await need().selectOption(String(a.value ?? ''), { timeout }) });
    case 'scroll': await p.mouse.wheel(a.delta_x ?? 0, a.delta_y ?? 300); break;
    case 'scroll_into_view': await need().scrollIntoViewIfNeeded({ timeout }); break;
    case 'get_text': return text({ success: true, text: await need().innerText({ timeout }) });
    case 'get_attribute': return text({ success: true, value: await need().getAttribute(a.attribute, { timeout }) });
    case 'count': return text({ success: true, count: await need().count() });
    case 'get_html': return text({ success: true, html: sel ? await need().innerHTML({ timeout }) : await p.content() });
    case 'evaluate': return text({ success: true, result: await p.evaluate(a.code ?? '') });
    case 'wait':
      if (sel) await p.waitForSelector(sel, { timeout, state: a.state ?? 'visible' });
      else if (a.text) await p.getByText(a.text).first().waitFor({ timeout, state: a.state ?? 'visible' });
      break;
    case 'url': return text({ success: true, url: p.url() });
    case 'title': return text({ success: true, title: await p.title() });
    case 'go_back': await p.goBack({ timeout }); break;
    case 'go_forward': await p.goForward({ timeout }); break;
    case 'reload': await p.reload({ timeout }); break;
    case 'set_content': await p.setContent(a.html ?? '', { timeout }); break;
    case 'screenshot': return capture(await p.screenshot({ fullPage: !!a.full_page }), { source: 'playwright' }, a.path);
    case 'tabs': return text({ success: true, tabs: await Promise.all(pages().map(async (t: any, i: number) => ({ index: i, url: t.url(), title: await t.title() }))) });
    case 'new_tab': { pw!.page = await pw!.context.newPage(); if (a.url) await pw!.page.goto(a.url, { timeout }); return text({ success: true, index: pages().length - 1 }); }
    case 'close_tab': case 'select_tab': {
      const t = pages()[a.tab_index ?? pages().indexOf(p)];
      if (!t) return text({ error: `no tab ${a.tab_index}` }, true);
      if (action === 'close_tab') { await t.close(); pw!.page = pages()[0] ?? null; } else { await t.bringToFront(); pw!.page = t; }
      break;
    }
    case 'cookies': return text({ success: true, cookies: await pw!.context.cookies() });
    default:
      return text({ error: `${action} runs on headless Playwright in the Python and Rust runtimes; this one carries the core, navigation and tabs.`, action }, true);
  }
  return text({ success: true, action });
}

async function run(args: Record<string, any>): Promise<ToolResult> {
  const extra = args.args ?? {};
  const unknown = Object.keys(extra).filter((k) => !ARGS.has(k)).sort();
  if (unknown.length) return text({ error: `Unknown args ${JSON.stringify(unknown)}. Typed parameters go outside args; action="help" names each action's args.` }, true);
  const a: Record<string, any> = { ...Object.fromEntries(TYPED.map((k) => [k, args[k]])), ...extra };
  const action: string = a.action || 'status';
  const spec = ACTIONS[action];
  if (!spec) return text({ error: `Unknown action "${action}". Core: ${CORE.join(', ')}. action="help" lists the rest.` }, true);
  if (action === 'help') return text(help(a.topic));
  if (action === 'browsers') {
    try {
      const b = await zap.browsers();
      return text({ success: true, transport: 'native-zap', browsers: b, count: b.length });
    } catch (e: any) {
      return text({ error: e.message, transport: 'native-zap' }, true);
    }
  }
  // A wait with nothing to wait for is a pause; no browser needs asking.
  if (action === 'wait' && !a.selector && !a.text && a.timeout) {
    await new Promise((r) => setTimeout(r, a.timeout));
    return text({ success: true, waited_ms: a.timeout });
  }

  const byRef = typeof a.selector === 'string' && REF.test(a.selector.trim());
  const be = backend();
  const filter = a.target_browser ?? (be === 'firefox' || be === 'chrome' ? be : null);
  const annotate = action === 'screenshot' && !!a.annotate;
  if (action === 'scroll' && a.delta_x == null && a.delta_y == null) a.delta_y = 300;

  if (be !== 'playwright' && spec[2]) {
    try {
      return await viaExtension(action, a, filter, annotate);
    } catch (e: any) {
      // Refs and labels exist only in the extension, and an explicit backend
      // means that browser: no Playwright stand-in for either.
      if (byRef || annotate || ['firefox', 'chrome', 'extension'].includes(be)) return text({ error: e.message, action, backend: be }, true);
    }
  }
  if (byRef) return text({ error: `${a.selector} is a snapshot ref, and refs come from the Hanzo extension; on headless Playwright pass a CSS selector.`, action }, true);
  if (annotate) return text({ error: 'annotate labels refs, which come from the Hanzo extension.', action }, true);
  try {
    return await viaPlaywright(action, a);
  } catch (e: any) {
    return text({ error: e.message, action }, true);
  }
}

export const browserTool: Tool = {
  name: 'browser',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: `${CORE.join(', ')}; help lists the rest` },
      selector: { type: 'string', description: 'Element: a snapshot ref (@e2) or a CSS selector' },
      url: { type: 'string', description: 'navigate: the URL' },
      text: { type: 'string', description: 'fill/type: the text; wait: text to appear' },
      key: { type: 'string', description: 'press: Enter, Tab, Escape, ArrowDown, Control+a' },
      code: { type: 'string', description: 'evaluate: JavaScript' },
      interactive: { type: 'boolean', description: 'snapshot: interactive elements only, flat' },
      compact: { type: 'boolean', description: 'snapshot: drop empty structure' },
      depth: { type: 'integer', description: 'snapshot: tree depth limit' },
      outline: { type: 'boolean', description: 'read: headings only' },
      filter: { type: 'string', description: 'read: only sections that mention this' },
      annotate: { type: 'boolean', description: 'screenshot: box every ref, label [N] = @eN' },
      timeout: { type: 'integer', description: 'wait: milliseconds' },
      tab_id: { type: 'string', description: 'Tab from tabs; default the active tab' },
      target_browser: { type: 'string', description: 'chrome | firefox, when several are connected' },
      topic: { type: 'string', description: 'help: one topic' },
      args: { type: 'object', description: 'Parameters of non-core actions, as help names them' },
    },
    required: ['action'],
  },
  handler: run,
};

/** Sugared cdp actions → the bare CDP method they map to. */
const SUGARED: Record<string, string> = { tabs: 'Target.getTargets', status: 'Browser.getVersion' };

export const cdpTool: Tool = {
  name: 'cdp',
  description: `Raw Chrome DevTools Protocol dispatch — peer of \`browser\`.

ACTIONS:
- send       : send a CDP method (method=, params=, tab_id=, target_browser=)
- tabs       : Target.getTargets — list connected tabs
- status     : Browser.getVersion — connection + version
- list_browsers : list extension providers (firefox/chrome/safari/edge) connected

Page.captureScreenshot answers with a downscaled JPEG (~1280px, q70) by default
to save context; the capture is saved to a file whose path is returned. Pass
params={"format":"png","maxWidth":0} for pixel detail.

EXAMPLES:
- cdp(action="send", method="Page.navigate", params={"url": "https://example.com"})
- cdp(action="send", method="Runtime.evaluate", params={"expression": "document.title"})
- cdp(action="tabs")
- cdp(action="status")

Use \`browser\` for high-level verbs (navigate, click, screenshot).`,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'CDP action: send | tabs | status | list_browsers', default: 'send' },
      method: { type: 'string', description: "CDP method name (e.g. 'Page.navigate', 'Runtime.evaluate')" },
      params: { type: 'object', description: 'CDP method params' },
      tab_id: { type: ['string', 'integer'], description: 'Target tab id (string or int)' },
      target_browser: { type: 'string', description: 'Provider filter: firefox|chrome|safari|edge' },
      client_id: { type: 'string', description: 'Specific extension client id' },
      timeout: { type: 'number', description: 'Per-call timeout (seconds)' },
    },
  },
  async handler(args: Record<string, any>): Promise<ToolResult> {
    const action = args.action ?? 'send';
    try {
      if (action === 'list_browsers') {
        const b = await zap.browsers();
        return text({ success: true, transport: 'native-zap', browsers: b, count: b.length });
      }
      const method = SUGARED[action] ?? (action === 'send' ? args.method : undefined);
      if (action === 'send' && !method) return text({ error: "method required for action=send (e.g. 'Page.navigate')", action }, true);
      if (!method) return text({ error: `unknown action '${action}'. Try: send, tabs, status, list_browsers` }, true);
      const provider = await zap.resolve(args.target_browser, args.client_id);
      if (!provider) return text({ error: UNPAIRED, transport: 'native-zap', method }, true);
      const wire: Record<string, unknown> = { ...(args.params ?? {}) };
      if (args.tab_id != null && wire.tabId == null) wire.tabId = args.tab_id;
      const params = Object.fromEntries(Object.entries(wire).filter(([, v]) => v != null).map(([k, v]) => [k, wireValue(v)]));
      const reply = await zap.route(provider, method, params, (args.timeout ?? 30) * 1000);
      const meta = { transport: 'native-zap', provider, method };
      if (reply.startsWith('ERR:')) return text({ error: reply.slice(4), ...meta }, true);
      const b64 = method.endsWith('captureScreenshot') ? extractB64(reply) : null;
      if (b64) return capture(Buffer.from(b64, 'base64'), meta);
      return text({ success: true, ...meta, result: reply });
    } catch (e: any) {
      return text({ error: e.message, transport: 'native-zap', action }, true);
    }
  },
};

export const browserTools: Tool[] = [browserTool, cdpTool];
