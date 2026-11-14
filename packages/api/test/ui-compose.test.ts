/**
 * Webmail in the dashboard UI: POST /ui/api/send and the compose dialog.
 *
 * Server half: the UI session cookie reaches the same send handler as
 * POST /v1/send (identity scoping, origin gate, body limit).
 * Client half: the repo has no jsdom, so the real modal.js + compose.js run
 * inside `new Function` against a small fake DOM. That pins the accessibility
 * contract: labels, field order, focus, Escape, status announcements.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './support/ui-i18n-shim.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.SEND_RATE_LIMIT = '100';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-ui-compose-'));
process.env.UI_ENABLED = 'true';

type SendInput = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
};

let sent: SendInput[] = [];
const sendMail = mock(async (input: SendInput) => {
  sent.push(input);
  return { messageId: `<ui-compose-${sent.length}@test.example>` };
});
mock.module('../src/lib/smtp.ts', () => ({ sendMail }));

type Auth = import('../src/lib/auth.ts').Auth;
const { createApp } = await import('../src/app.ts');
const { createIdentity } = await import('../src/lib/identities.ts');
const { config } = await import('../src/lib/config.ts');
const { resetRateLimits } = await import('../src/lib/ratelimit.ts');
const { UiSessionStore } = await import('../src/lib/ui-session.ts');
const { createUiApiRoutes } = await import('../src/routes/ui.ts');
const { Hono } = await import('hono');
const { I18N_EN } = await import('../src/ui/client/i18n-en.ts');
const { UI_JS } = await import('../src/ui/assets.ts');
const { MODAL_JS } = await import('../src/ui/client/components/modal.ts');
const { COMPOSE_PAGE_JS } = await import('../src/ui/client/pages/compose.ts');
const { INBOX_PAGE_JS } = await import('../src/ui/client/pages/inbox.ts');
const { API_JS } = await import('../src/ui/client/api.ts');

// config is a process-wide singleton frozen by whichever test file loads first.
const sendRateLimitBeforeFile = config.sendRateLimit;
Object.assign(config, { sendRateLimit: 100 });
afterAll(() => {
  Object.assign(config, { sendRateLimit: sendRateLimitBeforeFile });
});

const OWN = 'webmail-own@test.example';
const OTHER = 'webmail-other@test.example';
createIdentity({ localpart: 'webmail-own' });
createIdentity({ localpart: 'webmail-other' });

const ORIGIN = 'https://mail.example';
const sameOrigin = {
  'content-type': 'application/json',
  origin: ORIGIN,
  'sec-fetch-site': 'same-origin',
};

function makeApp() {
  return createApp({
    uiEnabled: true,
    tokenResolver: (token: string): Auth | null => {
      if (token === 'admin-token') return { kind: 'admin' };
      if (token === 'own-token') return { kind: 'identity', address: OWN };
      return null;
    },
  });
}

async function login(app: ReturnType<typeof makeApp>, token: string): Promise<string> {
  const response = await app.request(`${ORIGIN}/ui/api/session`, {
    method: 'POST',
    headers: sameOrigin,
    body: JSON.stringify({ token }),
  });
  expect(response.status).toBe(200);
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]!;
  expect(cookie.startsWith('oae_ui=')).toBe(true);
  return cookie;
}

function send(
  app: ReturnType<typeof makeApp>,
  cookie: string | null,
  body: unknown,
  headers: Record<string, string> = sameOrigin,
) {
  return app.request(`${ORIGIN}/ui/api/send`, {
    method: 'POST',
    headers: { ...headers, ...(cookie ? { cookie } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  sent = [];
  sendMail.mockClear();
  resetRateLimits();
});

describe('POST /ui/api/send (webmail)', () => {
  test('without a session cookie the request is rejected and nothing is sent', async () => {
    const response = await send(makeApp(), null, {
      from: OWN,
      to: 'someone@example.net',
      subject: 'Hi',
      text: 'Hello',
    });
    expect(response.status).toBe(401);
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('the bearer-only /v1/send still refuses the UI session cookie', async () => {
    const app = makeApp();
    const cookie = await login(app, 'own-token');
    const response = await app.request(`${ORIGIN}/v1/send`, {
      method: 'POST',
      headers: { ...sameOrigin, cookie },
      body: JSON.stringify({ from: OWN, to: 'someone@example.net', subject: 'Hi', text: 'Hello' }),
    });
    expect(response.status).toBe(401);
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('an identity session sends as itself, with reply threading passed through', async () => {
    const app = makeApp();
    const cookie = await login(app, 'own-token');
    const response = await send(app, cookie, {
      from: OWN,
      to: ['someone@example.net', 'second@example.net'],
      subject: 'Re: Question',
      text: 'Answer\n\n> Question',
      inReplyTo: '<orig@example.net>',
      references: ['<root@example.net>', '<orig@example.net>'],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { messageId?: string };
    expect(body.messageId).toBe('<ui-compose-1@test.example>');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: OWN,
      to: ['someone@example.net', 'second@example.net'],
      subject: 'Re: Question',
      text: 'Answer\n\n> Question',
      inReplyTo: '<orig@example.net>',
      references: ['<root@example.net>', '<orig@example.net>'],
    });
  });

  test('an identity session may not send from another address', async () => {
    const app = makeApp();
    const cookie = await login(app, 'own-token');
    const response = await send(app, cookie, {
      from: OTHER,
      to: 'someone@example.net',
      subject: 'Hi',
      text: 'Hello',
    });
    expect(response.status).toBe(403);
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('an admin session may send from any existing identity, but not from an unknown one', async () => {
    const app = makeApp();
    const cookie = await login(app, 'admin-token');
    const ok = await send(app, cookie, { from: OTHER, to: 'someone@example.net', subject: 'Hi', text: 'Hello' });
    expect(ok.status).toBe(200);
    expect(sent[0]?.from).toBe(OTHER);
    const unknown = await send(app, cookie, {
      from: 'nobody@test.example',
      to: 'someone@example.net',
      subject: 'Hi',
      text: 'Hello',
    });
    expect(unknown.status).toBe(403);
    expect(sent).toHaveLength(1);
  });

  test('a cross-site request is blocked by the origin gate', async () => {
    const app = makeApp();
    const cookie = await login(app, 'own-token');
    const response = await send(
      app,
      cookie,
      { from: OWN, to: 'someone@example.net', subject: 'Hi', text: 'Hello' },
      { 'content-type': 'application/json', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    );
    expect(response.status).toBe(403);
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('invalid input is a 400 and unknown keys are refused like on /v1/send', async () => {
    const app = makeApp();
    const cookie = await login(app, 'own-token');
    const badAddress = await send(app, cookie, { from: OWN, to: 'not-an-address', subject: 'Hi', text: 'Hello' });
    expect(badAddress.status).toBe(400);
    const unknownKey = await send(app, cookie, {
      from: OWN,
      to: 'someone@example.net',
      subject: 'Hi',
      text: 'Hello',
      attachments: [],
    });
    expect(unknownKey.status).toBe(400);
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('a mail body above the 4 KiB UI limit is accepted on the send path only', async () => {
    const app = makeApp();
    const cookie = await login(app, 'own-token');
    const text = 'Long line of quoted mail text.\n'.repeat(2000);
    expect(text.length).toBeGreaterThan(4 * 1024);
    const response = await send(app, cookie, { from: OWN, to: 'someone@example.net', subject: 'Long', text });
    expect(response.status).toBe(200);
    expect(sent[0]?.text).toBe(text);

    // Every other /ui/api write keeps the small limit.
    const other = await app.request(`${ORIGIN}/ui/api/messages/1/seen`, {
      method: 'POST',
      headers: { ...sameOrigin, cookie },
      body: JSON.stringify({ address: OWN, seen: true, padding: 'x'.repeat(8 * 1024) }),
    });
    expect(other.status).toBe(413);
  });
});

describe('UI message detail carries reply threading ids', () => {
  function detailApp(extra: Record<string, unknown>) {
    const store = new UiSessionStore({
      resolveToken: (token) => (token === 'ok' ? { kind: 'admin' } : null),
    });
    const created = store.create('ok', '127.0.0.1');
    if (!created.ok) throw new Error('test session was not created');
    const app = new Hono();
    app.route(
      '/ui/api',
      createUiApiRoutes(store, {
        listIdentities: () => [],
        listMessages: mock(async () => []),
        setMessageSeen: mock(async () => true),
        getMailboxScan: mock(async () => ({
          kind: 'ready' as const,
          now: Date.now(),
          snapshot: null,
          cached: false,
          revalidating: false,
          refreshError: false,
        })),
        getMessage: mock(async () => ({
          id: '2',
          from: 'Ada <ada@example.net>',
          to: OWN,
          subject: 'Question',
          date: '2026-07-27T02:00:00.000Z',
          text: 'Question',
          html: undefined,
          otp: { codes: [], links: [] },
          links: [],
          source: 'external' as const,
          ...extra,
        })),
        setPushContentTier: mock(() => null),
      } as never),
    );
    return { app, cookie: `oae_ui=${created.sid}` };
  }

  test('messageId and references are projected when the mail has them', async () => {
    const { app, cookie } = detailApp({
      messageId: '<orig@example.net>',
      references: ['<root@example.net>'],
    });
    const response = await app.request(`/ui/api/messages/2?address=${encodeURIComponent(OWN)}`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.messageId).toBe('<orig@example.net>');
    expect(body.references).toEqual(['<root@example.net>']);
  });

  test('both keys are omitted when the mail has none', async () => {
    const { app, cookie } = detailApp({});
    const response = await app.request(`/ui/api/messages/2?address=${encodeURIComponent(OWN)}`, {
      headers: { cookie },
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect('messageId' in body).toBe(false);
    expect('references' in body).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Fake DOM: just enough for modal.js + compose.js.                    */
/* ------------------------------------------------------------------ */

type Listener = (event: FakeEvent) => unknown;
type FakeEvent = { key?: string; shiftKey?: boolean; preventDefault: () => void; defaultPrevented: boolean };

function fakeEvent(init: { key?: string; shiftKey?: boolean } = {}): FakeEvent {
  const event: FakeEvent = {
    ...init,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  return event;
}

class FakeDocument {
  activeElement: FakeElement | null = null;
  body = new FakeElement(this, 'body');
  listeners: Record<string, Listener[]> = {};
  createElement(tag: string) {
    return new FakeElement(this, tag);
  }
  addEventListener(type: string, listener: Listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  fire(type: string, event: FakeEvent) {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
}

class FakeElement {
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  id = '';
  className = '';
  textContent = '';
  hidden = false;
  disabled = false;
  selected = false;
  type = '';
  rows = 0;
  maxLength = 0;
  noValidate = false;
  scrollTop = 0;
  private ownValue = '';
  constructor(
    private doc: FakeDocument,
    public tagName: string,
  ) {}

  get isConnected() {
    return true;
  }
  get options() {
    return this.children.filter((child) => child.tagName === 'option');
  }
  get value(): string {
    if (this.tagName !== 'select') return this.ownValue;
    const picked = this.options.find((option) => option.selected) ?? this.options[0];
    return picked ? picked.value : '';
  }
  set value(next: string) {
    this.ownValue = next;
  }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    const write = (list: string[]) => {
      this.className = list.join(' ');
    };
    return {
      add: (name: string) => {
        if (!names().includes(name)) write([...names(), name]);
      },
      remove: (name: string) => write(names().filter((item) => item !== name)),
      contains: (name: string) => names().includes(name),
      toggle: (name: string, force?: boolean) => {
        const want = force === undefined ? !names().includes(name) : force;
        write(names().filter((item) => item !== name).concat(want ? [name] : []));
      },
    };
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = String(value);
  }
  getAttribute(name: string) {
    return name in this.attrs ? this.attrs[name]! : null;
  }
  removeAttribute(name: string) {
    delete this.attrs[name];
  }
  append(...nodes: FakeElement[]) {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: FakeElement[]) {
    this.children = [];
    this.append(...nodes);
  }
  insertBefore(node: FakeElement, before: FakeElement) {
    node.parentNode = this;
    this.children.splice(this.children.indexOf(before), 0, node);
  }
  addEventListener(type: string, listener: Listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  fire(type: string, event: FakeEvent = fakeEvent()) {
    const results = (this.listeners[type] ?? []).map((listener) => listener(event));
    return Promise.all(results);
  }
  click() {
    return this.fire('click');
  }
  focus() {
    this.doc.activeElement = this;
  }
  setSelectionRange() {}
  closest(selector: string): FakeElement | null {
    const id = selector.replace(/^#/, '');
    let node: FakeElement | null = this;
    while (node) {
      if (node.id === id) return node;
      node = node.parentNode;
    }
    return null;
  }
  /** Depth-first, document order. */
  walk(): FakeElement[] {
    return [this, ...this.children.flatMap((child) => child.walk())];
  }
  byId(id: string): FakeElement {
    const found = this.walk().find((node) => node.id === id);
    if (!found) throw new Error(`missing #${id}`);
    return found;
  }
}

type Identity = { address: string; name?: string };
type Detail = {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  text: string;
  messageId?: string;
  references?: string[];
};

const MODAL_GLOBALS = [
  'tokenModal', 'confirmModal', 'createModal', 'deviceAddModal', 'devicePairModal',
  'devicePairPassword', 'devicePairQr', 'devicePairServer', 'devicePairUser', 'devicePairTopics',
  'devicePairName', 'tokenValue', 'tokenModalTitle', 'tokenCopyButton', 'confirmModalTitle',
  'confirmModalText', 'confirmModalRisk', 'confirmModalConfirm', 'confirmModalCancel',
  'createModalError', 'createModalSubmit', 'deviceAddSubmit', 'createName', 'createLocalpart',
  'createDomain',
];

function harness(options: {
  identities?: Identity[];
  activeAddress?: string;
  activeFolder?: string;
  sendImpl?: (body: string, key: string) => Promise<unknown>;
} = {}) {
  const doc = new FakeDocument();
  const inboxView = doc.createElement('section');
  const opener = doc.createElement('button');
  opener.id = 'opener';
  inboxView.append(opener);
  for (const name of MODAL_GLOBALS) {
    const node = doc.createElement('div');
    node.hidden = true;
    node.id = name;
    inboxView.append(node);
  }
  const calls = {
    sends: [] as Array<{ body: Record<string, unknown>; key: string }>,
    announced: [] as string[],
    refreshes: 0,
  };
  const state = {
    identities: options.identities ?? [{ address: OWN, name: 'Own' }, { address: OTHER }],
    activeAddress: options.activeAddress ?? OWN,
    activeFolder: options.activeFolder ?? 'inbox',
  };
  const sendMessage = async (body: string, key: string) => {
    calls.sends.push({ body: JSON.parse(body), key });
    if (options.sendImpl) return options.sendImpl(body, key);
    return { messageId: '<x@test.example>' };
  };
  const api = new Function(
    'document', 'window', 'state', 'inboxView', 'sendMessage', 'announce', 'refreshMessages',
    'formatDate', 'isAdmin', 'apiJson', ...MODAL_GLOBALS,
    MODAL_JS + COMPOSE_PAGE_JS +
      '\nreturn { openCompose: openCompose, submitCompose: submitCompose, isComposeOpen: isComposeOpen,' +
      ' closeAllModals: closeAllModals, appendComposeActions: appendComposeActions };',
  )(
    doc,
    { setTimeout, crypto: { randomUUID: () => crypto.randomUUID() } },
    state,
    inboxView,
    sendMessage,
    (message: string) => calls.announced.push(message),
    async () => {
      calls.refreshes += 1;
    },
    (value: string) => `DATE(${value})`,
    () => true,
    async () => ({}),
    ...MODAL_GLOBALS.map((name) => inboxView.byId(name)),
  ) as {
    openCompose: (mode: string, detail?: Detail) => void;
    submitCompose: () => Promise<void>;
    isComposeOpen: () => boolean;
    closeAllModals: () => void;
    appendComposeActions: (header: FakeElement, detail: Detail) => void;
  };
  const el = (id: string) => inboxView.byId(id);
  const open = (mode: string, detail?: Detail) => {
    opener.focus();
    api.openCompose(mode, detail);
  };
  return { doc, inboxView, opener, calls, state, api, el, open };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const DETAIL: Detail = {
  id: '7',
  from: 'Ada Lovelace <ada@example.net>',
  to: OWN,
  subject: 'Question',
  date: '2026-07-27T02:00:00.000Z',
  text: 'First line\r\nSecond line',
  messageId: '<orig@example.net>',
  references: ['<root@example.net>'],
};

describe('compose dialog: accessibility contract', () => {
  test('it is a labelled modal dialog', () => {
    const h = harness();
    h.open('new');
    const overlay = h.el('compose-modal');
    expect(overlay.hidden).toBe(false);
    const dialog = overlay.children[0]!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const title = h.el(dialog.getAttribute('aria-labelledby')!);
    expect(title.tagName).toBe('h2');
    expect(title.textContent).toBe(I18N_EN['compose.title.newMessage']!);
  });

  test('every field has a visible label whose for attribute points at it', () => {
    const h = harness();
    h.open('new');
    const labels = h.el('compose-modal').walk().filter((node) => node.tagName === 'label');
    const expected: Array<[string, string]> = [
      ['compose-from', I18N_EN['shell.html.from']!],
      ['compose-to', I18N_EN['shell.html.to']!],
      ['compose-subject', I18N_EN['tasks.action.subject']!],
      ['compose-text', I18N_EN['compose.label.text']!],
    ];
    expect(labels.map((label) => [label.getAttribute('for'), label.textContent])).toEqual(expected);
    for (const label of labels) {
      expect(label.hidden).toBe(false);
      expect(label.className).not.toContain('sr-only');
      expect(label.textContent.length).toBeGreaterThan(0);
    }
    for (const [id] of expected) expect(h.el(id).id).toBe(id);
  });

  test('keyboard order is From, To, Subject, Text, Send, Cancel and no positive tabindex is used', () => {
    const h = harness();
    h.open('new');
    const focusable = h
      .el('compose-modal')
      .walk()
      .filter((node) => ['select', 'input', 'textarea', 'button'].includes(node.tagName));
    expect(focusable.map((node) => node.id)).toEqual([
      'compose-from',
      'compose-to',
      'compose-subject',
      'compose-text',
      'compose-send',
      'compose-cancel',
    ]);
    for (const node of h.el('compose-modal').walk()) {
      expect(node.getAttribute('tabindex')).toBeNull();
    }
  });

  test('Send and Cancel are real buttons with text', () => {
    const h = harness();
    h.open('new');
    const sendButton = h.el('compose-send');
    const cancel = h.el('compose-cancel');
    for (const button of [sendButton, cancel]) {
      expect(button.tagName).toBe('button');
      expect(button.type).toBe('button');
      expect(button.getAttribute('aria-label')).toBeNull();
    }
    expect(sendButton.textContent).toBe('Send');
    expect(cancel.textContent).toBe('Cancel');
  });

  test('opening puts focus on the To field', () => {
    const h = harness();
    h.open('new');
    expect(h.doc.activeElement).toBe(h.el('compose-to'));
    const reply = harness();
    reply.open('reply', DETAIL);
    expect(reply.doc.activeElement).toBe(reply.el('compose-to'));
  });

  test('Escape closes the dialog and focus returns to the button that opened it', () => {
    const h = harness();
    h.open('new');
    h.el('compose-text').value = 'draft';
    const event = fakeEvent({ key: 'Escape' });
    h.doc.fire('keydown', event);
    expect(event.defaultPrevented).toBe(true);
    expect(h.api.isComposeOpen()).toBe(false);
    expect(h.doc.activeElement).toBe(h.opener);
    // A closed dialog keeps no text for the next opening.
    h.open('new');
    expect(h.el('compose-text').value).toBe('');
  });

  test('Cancel closes the dialog and focus returns to the opener', async () => {
    const h = harness();
    h.open('new');
    await h.el('compose-cancel').click();
    expect(h.api.isComposeOpen()).toBe(false);
    expect(h.doc.activeElement).toBe(h.opener);
    expect(h.calls.sends).toHaveLength(0);
  });

  test('Tab wraps inside the dialog in both directions', async () => {
    const h = harness();
    h.open('new');
    const overlay = h.el('compose-modal');
    h.el('compose-cancel').focus();
    const forward = fakeEvent({ key: 'Tab' });
    await overlay.fire('keydown', forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(h.doc.activeElement).toBe(h.el('compose-from'));
    const backward = fakeEvent({ key: 'Tab', shiftKey: true });
    await overlay.fire('keydown', backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(h.doc.activeElement).toBe(h.el('compose-cancel'));
    // In the middle the browser keeps its natural order.
    h.el('compose-to').focus();
    const middle = fakeEvent({ key: 'Tab' });
    await overlay.fire('keydown', middle);
    expect(middle.defaultPrevented).toBe(false);
  });

  test('the status area is a polite live region', () => {
    const h = harness();
    h.open('new');
    const status = h.el('compose-status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  test('pressing Enter in a field does not submit the form', async () => {
    const h = harness();
    h.open('new');
    const submit = fakeEvent();
    await h.el('compose-form').fire('submit', submit);
    expect(submit.defaultPrevented).toBe(true);
    expect(h.calls.sends).toHaveLength(0);
  });

  test('From lists the own identities and preselects the open mailbox', () => {
    const h = harness({ activeAddress: OTHER });
    h.open('new');
    const from = h.el('compose-from');
    expect(from.options.map((option) => option.value)).toEqual([OWN, OTHER]);
    expect(from.value).toBe(OTHER);
  });
});

describe('compose dialog: reply and forward', () => {
  test('reply fills To, Subject, the quoted text and the threading ids', async () => {
    const h = harness();
    h.open('reply', DETAIL);
    expect(h.el('compose-title').textContent).toBe('Reply');
    expect(h.el('compose-to').value).toBe('ada@example.net');
    expect(h.el('compose-subject').value).toBe('Re: Question');
    expect(h.el('compose-text').value).toBe(
      '\n\nOn DATE(2026-07-27T02:00:00.000Z), Ada Lovelace <ada@example.net> wrote:\n' +
        '> First line\n> Second line\n',
    );
    await h.el('compose-send').click();
    expect(h.calls.sends).toHaveLength(1);
    expect(h.calls.sends[0]!.body).toEqual({
      from: OWN,
      to: ['ada@example.net'],
      subject: 'Re: Question',
      text: h.calls.sends[0]!.body.text,
      inReplyTo: '<orig@example.net>',
      references: ['<root@example.net>', '<orig@example.net>'],
    });
  });

  test('an existing Re: prefix is not doubled, whatever its case', () => {
    const h = harness();
    h.open('reply', { ...DETAIL, subject: 'RE: Question' });
    expect(h.el('compose-subject').value).toBe('RE: Question');
  });

  test('a mail without a Message-ID is answered without threading fields', async () => {
    const h = harness();
    h.open('reply', { ...DETAIL, messageId: undefined, references: undefined });
    await h.el('compose-send').click();
    const body = h.calls.sends[0]!.body;
    expect('inReplyTo' in body).toBe(false);
    expect('references' in body).toBe(false);
  });

  test('forward leaves To empty, prefixes Fwd: and puts the original below', async () => {
    const h = harness();
    h.open('forward', DETAIL);
    expect(h.el('compose-title').textContent).toBe('Forward message');
    expect(h.el('compose-to').value).toBe('');
    expect(h.el('compose-subject').value).toBe('Fwd: Question');
    const text = h.el('compose-text').value;
    expect(text.startsWith('\n\n---------- Forwarded message ----------\n')).toBe(true);
    expect(text).toContain('From: Ada Lovelace <ada@example.net>\n');
    expect(text).toContain('Subject: Question\n');
    expect(text.endsWith('\nFirst line\nSecond line\n')).toBe(true);
    h.el('compose-to').value = 'bob@example.net';
    await h.el('compose-send').click();
    const body = h.calls.sends[0]!.body;
    expect(body.to).toEqual(['bob@example.net']);
    expect('inReplyTo' in body).toBe(false);
  });

  test('the detail header gets Reply and Forward buttons with text', async () => {
    const h = harness();
    const header = h.doc.createElement('header');
    h.inboxView.append(header);
    h.api.appendComposeActions(header, DETAIL);
    const buttons = header.walk().filter((node) => node.tagName === 'button');
    expect(buttons.map((button) => button.textContent)).toEqual(['Reply', 'Forward']);
    for (const button of buttons) expect(button.type).toBe('button');
    buttons[1]!.focus();
    await buttons[1]!.click();
    expect(h.el('compose-subject').value).toBe('Fwd: Question');
    h.doc.fire('keydown', fakeEvent({ key: 'Escape' }));
    expect(h.doc.activeElement).toBe(buttons[1]!);
  });
});

describe('compose dialog: sending', () => {
  test('several recipients are split, trimmed and de-duplicated', async () => {
    const h = harness();
    h.open('new');
    h.el('compose-to').value = ' a@example.net, b@example.net;A@example.net  c@example.net ';
    h.el('compose-subject').value = 'Hello';
    h.el('compose-text').value = 'Body';
    await h.el('compose-send').click();
    expect(h.calls.sends[0]!.body).toEqual({
      from: OWN,
      to: ['a@example.net', 'b@example.net', 'c@example.net'],
      subject: 'Hello',
      text: 'Body',
    });
    expect(h.calls.sends[0]!.key.length).toBeGreaterThan(8);
  });

  test('an empty or invalid To is announced, marked invalid and focused; nothing is sent', async () => {
    const h = harness();
    h.open('new');
    await h.el('compose-send').click();
    await tick();
    expect(h.calls.sends).toHaveLength(0);
    expect(h.el('compose-status').textContent).toBe('Enter at least one recipient.');
    expect(h.el('compose-status').classList.contains('error')).toBe(true);
    expect(h.el('compose-to').getAttribute('aria-invalid')).toBe('true');
    expect(h.doc.activeElement).toBe(h.el('compose-to'));

    h.el('compose-to').value = 'ok@example.net, broken';
    await h.el('compose-send').click();
    await tick();
    expect(h.calls.sends).toHaveLength(0);
    expect(h.el('compose-status').textContent).toBe('broken is not a valid email address.');

    h.el('compose-to').value = 'ok@example.net';
    await h.el('compose-send').click();
    expect(h.calls.sends).toHaveLength(1);
    expect(h.el('compose-to').getAttribute('aria-invalid')).toBeNull();
  });

  test('success closes the dialog, returns focus and announces the result', async () => {
    const h = harness();
    h.open('new');
    h.el('compose-to').value = 'ada@example.net';
    await h.el('compose-send').click();
    expect(h.api.isComposeOpen()).toBe(false);
    expect(h.doc.activeElement).toBe(h.opener);
    expect(h.calls.announced).toEqual(['Message sent to ada@example.net.']);
    // The Sent folder is not on screen, so there is nothing to reload.
    expect(h.calls.refreshes).toBe(0);
  });

  test('success reloads the Sent folder when it is on screen, then announces', async () => {
    const h = harness({ activeFolder: 'sent' });
    h.open('new');
    h.el('compose-to').value = 'ada@example.net';
    await h.el('compose-send').click();
    expect(h.calls.refreshes).toBe(1);
    expect(h.calls.announced).toEqual(['Message sent to ada@example.net.']);
  });

  test('a server error keeps the dialog and the text, and is announced in the status area', async () => {
    const h = harness({
      sendImpl: async () => {
        throw Object.assign(new Error('request_failed'), { status: 502, body: { error: 'smtp_error' } });
      },
    });
    h.open('new');
    h.el('compose-to').value = 'ada@example.net';
    h.el('compose-text').value = 'Keep me';
    await h.el('compose-send').click();
    await tick();
    expect(h.api.isComposeOpen()).toBe(true);
    expect(h.el('compose-text').value).toBe('Keep me');
    expect(h.el('compose-status').textContent).toBe(I18N_EN['compose.error.mailServer']!);
    expect(h.el('compose-send').disabled).toBe(false);
    expect(h.el('compose-send').textContent).toBe('Send');
    expect(h.calls.announced).toEqual([]);
  });

  test('a rate limit names the waiting time', async () => {
    const h = harness({
      sendImpl: async () => {
        throw Object.assign(new Error('request_failed'), {
          status: 429,
          body: { error: 'rate_limited', retryAfterSec: 42 },
        });
      },
    });
    h.open('new');
    h.el('compose-to').value = 'ada@example.net';
    await h.el('compose-send').click();
    await tick();
    expect(h.el('compose-status').textContent).toBe('Send limit reached. Try again in 42 seconds.');
  });

  test('a retry after a network failure reuses the idempotency key; an edit gets a new one', async () => {
    let failures = 2;
    const h = harness({
      sendImpl: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new TypeError('network');
        }
        return {};
      },
    });
    h.open('new');
    h.el('compose-to').value = 'ada@example.net';
    h.el('compose-text').value = 'One';
    await h.el('compose-send').click();
    await tick();
    expect(h.el('compose-status').textContent).toBe(I18N_EN['compose.error.network']!);
    await h.el('compose-send').click();
    expect(h.calls.sends[1]!.key).toBe(h.calls.sends[0]!.key);
    h.el('compose-text').value = 'Two';
    await h.el('compose-send').click();
    expect(h.calls.sends[2]!.key).not.toBe(h.calls.sends[0]!.key);
    expect(h.api.isComposeOpen()).toBe(false);
  });

  test('a second click while sending does not send twice', async () => {
    let release: () => void = () => {};
    const h = harness({
      sendImpl: () => new Promise((resolve) => {
        release = () => resolve({});
      }),
    });
    h.open('new');
    h.el('compose-to').value = 'ada@example.net';
    const first = h.el('compose-send').click();
    expect(h.el('compose-send').disabled).toBe(true);
    expect(h.el('compose-send').textContent).toBe('Sending…');
    const second = h.el('compose-send').click();
    release();
    await Promise.all([first, second]);
    expect(h.calls.sends).toHaveLength(1);
  });

  test('without any identity the dialog says so and Send is disabled', async () => {
    const h = harness({ identities: [], activeAddress: '' });
    h.open('new');
    await tick();
    expect(h.el('compose-send').disabled).toBe(true);
    expect(h.el('compose-status').textContent).toBe(I18N_EN['compose.error.noSender']!);
  });
});

describe('compose wiring in the served bundle', () => {
  test('sendMessage posts to the UI endpoint, never to the bearer-only /v1 path', () => {
    const start = API_JS.indexOf('async function sendMessage(');
    const body = API_JS.slice(start, API_JS.indexOf('async function handleCreateSubmit('));
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("apiJson('/ui/api/send'");
    expect(body).toContain("method: 'POST'");
    expect(body).not.toContain('/v1/');
    expect(COMPOSE_PAGE_JS).not.toContain('/v1/');
  });

  test('the folder bar gets one persistent New mail button outside the re-rendered list', () => {
    expect(INBOX_PAGE_JS).toContain("composeButton = document.createElement('button');");
    expect(INBOX_PAGE_JS).toContain("composeButton.textContent = t('compose.action.newMail');");
    expect(INBOX_PAGE_JS).toContain('folderList.parentNode.insertBefore(composeButton, folderList);');
    const render = INBOX_PAGE_JS.slice(
      INBOX_PAGE_JS.indexOf('function renderFolderNav('),
      INBOX_PAGE_JS.indexOf('function renderMessages('),
    );
    expect(render.indexOf('ensureComposeButton();')).toBeGreaterThan(-1);
    expect(render.indexOf('ensureComposeButton();')).toBeLessThan(render.indexOf('folderList.replaceChildren();'));
  });

  test('the message view adds Reply and Forward, and the bundle order is inbox, compose', () => {
    const detail = UI_JS.slice(UI_JS.indexOf('function renderDetail('), UI_JS.indexOf('async function toggleSeen('));
    expect(detail).toContain('appendComposeActions(header, detail);');
    expect(UI_JS.indexOf('function renderFolderNav(')).toBeLessThan(UI_JS.indexOf('function buildComposeModal('));
    expect(UI_JS.indexOf('function appendComposeActions(')).toBeLessThan(UI_JS.indexOf('function renderDetail('));
  });

  test('every compose key exists in the English dictionary', () => {
    const used = new Set<string>();
    for (const source of [COMPOSE_PAGE_JS, INBOX_PAGE_JS]) {
      for (const match of source.matchAll(/t(?:Format)?\('(compose\.[\w.]+)'/g)) used.add(match[1]!);
    }
    expect(used.size).toBeGreaterThan(15);
    for (const key of used) expect(typeof I18N_EN[key]).toBe('string');
  });
});
