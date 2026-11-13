import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

const FETCHED = {
  ok: true,
  models: ['alpha-model', 'beta-model', 'gamma-model', 'delta-model'],
  allModels: ['alpha-model', 'beta-model', 'gamma-model', 'delta-model', 'chat-model'],
  filteredCount: 1,
  names: {
    'alpha-model': 'Alpha',
    'gamma-model': 'Gamma Model'
  }
};

/** A stateful React stand-in, so clicks and drags re-render the settings section. */
function createHarness({ config, modelsResponse = FETCHED, adapters = [], primitives = null } = {}) {
  let loaded = null;
  let dirty = false;
  const hookStores = new Map();
  let currentHooks = null;
  let hookIndex = 0;

  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    Fragment: 'Fragment',
    useState(initial) {
      const index = hookIndex++;
      const hooks = currentHooks;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], (next) => {
        hooks[index] = typeof next === 'function' ? next(hooks[index]) : next;
        dirty = true;
      }];
    },
    useEffect() { hookIndex += 1; },
    useLayoutEffect() { hookIndex += 1; },
    useMemo(fn) { hookIndex += 1; return fn(); },
    useCallback(fn) { hookIndex += 1; return fn; },
    useRef(value) {
      const index = hookIndex++;
      if (!(index in currentHooks)) currentHooks[index] = { current: value };
      return currentHooks[index];
    }
  };
  const window = {
    __ModuleLoader__: { load(definition) { loaded = definition; } },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {}
  };
  const document = {
    querySelectorAll() { return []; }, querySelector() { return null; }, getElementById() { return null; },
    createElement() { return { id: '', textContent: '', parentNode: null }; },
    head: { appendChild() {} }, body: {}, styleSheets: [], adoptedStyleSheets: []
  };
  const fetchCalls = [];
  const context = {
    window, document, React, console,
    Event: class Event { constructor(type) { this.type = type; } },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    MutationObserver: class { observe() {} disconnect() {} },
    AbortSignal: globalThis.AbortSignal, Response: globalThis.Response,
    fetch: async (url, init) => {
      fetchCalls.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body });
      if (String(url).endsWith('/api/mo-image/models')) {
        return new Response(JSON.stringify(modelsResponse), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        ok: true, config, adapters,
        providerPresets: [{ id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', adapter: '', models: [], website: 'https://platform.openai.com/api-keys' }],
        localPresets: []
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    setTimeout: () => 0, clearTimeout() {}, URL
  };
  vm.runInNewContext(source, context, { filename: 'client.js' });
  const api = loaded.factory((name) => {
    if (name === 'react') return React;
    if (name === 'react-dom') return { createPortal(node) { return node; } };
    if (name === '@deepseek-ai/dsh-client-ui-primitives' && primitives) return primitives;
    return {};
  });

  const dictionaries = new Map();
  const locale = {
    active: 'en',
    register(ns, dicts) { dictionaries.set(ns, dicts); return () => {}; },
    bind(ns) { return (key, params) => {
      const dicts = dictionaries.get(ns) || {};
      let template = key;
      for (const lang of [locale.active, 'en']) { const hit = dicts[lang] && dicts[lang][key]; if (typeof hit === 'string') { template = hit; break; } }
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
    }; },
    getSnapshot() { return { active: locale.active, revision: 0, locales: [] }; },
    subscribe() { return () => {}; }
  };
  const registrations = [];
  api.apply({
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    slots: { inject(_key, callback) { callback(); }, register(definition, component) { registrations.push({ definition, component }); return () => {}; } },
    locale
  });

  function render(node) {
    if (node === null || node === undefined) return null;
    if (Array.isArray(node)) return node.map(render);
    if (typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      if (!hookStores.has(node.type)) hookStores.set(node.type, []);
      const previous = currentHooks;
      currentHooks = hookStores.get(node.type);
      hookIndex = 0;
      // React hands children to a component through props; mirror that.
      const props = Object.assign({}, node.props || {});
      if (node.children && node.children.length) props.children = node.children.length === 1 ? node.children[0] : node.children;
      const output = node.type(props);
      currentHooks = previous;
      return render(output);
    }
    return { type: node.type, props: node.props || {}, children: (node.children || []).map(render) };
  }

  function renderRoot() {
    const settings = registrations.find(({ definition }) => definition.name === 'settings.section');
    for (let i = 0; i < 12; i += 1) {
      dirty = false;
      const tree = render({ type: settings.component, props: settings.definition.inject(), children: [] });
      if (!dirty) return tree;
    }
    throw new Error('render did not settle');
  }

  return { fetchCalls, renderRoot };
}

function walk(node, visit) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) { for (const item of node) walk(item, visit); return; }
  if (typeof node !== 'object') return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

function findAll(node, predicate) {
  const out = [];
  walk(node, (item) => { if (predicate(item)) out.push(item); });
  return out;
}

function classTokens(node) {
  const value = node && node.props && node.props.className;
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : [];
}

function hasClass(node, local) {
  return classTokens(node).some((token) => token === local || token.endsWith('_' + local));
}

function textOf(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const item of node) textOf(item, out); return out; }
  for (const child of node.children || []) textOf(child, out);
  return out;
}

function findButton(node, label) {
  return findAll(node, (item) => item.type === 'button' && textOf(item).join('').includes(label))[0] || null;
}

function modelRows(tree) {
  return findAll(tree, (node) => hasClass(node, 'modelEntry')).map((row) => {
    const inputs = findAll(row, (node) => node.type === 'input' && node.props.type === 'text');
    return {
      row,
      id: inputs[0] && inputs[0].props.value,
      name: inputs[1] && inputs[1].props.value,
      idInput: inputs[0],
      nameInput: inputs[1],
      handle: findAll(row, (node) => hasClass(node, 'modelDragHandle'))[0] || null
    };
  });
}

function candidateRows(tree) {
  return findAll(tree, (node) => node.type === 'li' && hasClass(node, 'candidate')).map((row) => {
    const checkbox = findAll(row, (node) => node.type === 'input' && node.props.type === 'checkbox')[0];
    const idNode = findAll(row, (node) => hasClass(node, 'candidateId'))[0];
    return { id: idNode ? textOf(idNode).join('') : '', checked: !!(checkbox && checkbox.props.checked), toggle: checkbox && checkbox.props.onChange };
  });
}

function flattenChildren(children, out = []) {
  for (const child of children || []) {
    if (Array.isArray(child)) { flattenChildren(child, out); continue; }
    if (child && child.type === 'Fragment') { flattenChildren(child.children, out); continue; }
    if (child) out.push(child);
  }
  return out;
}

function fakeEvent(overrides = {}) {
  return Object.assign({
    preventDefault() {},
    stopPropagation() {},
    dataTransfer: { effectAllowed: '', dropEffect: '', setData() {} },
    currentTarget: {
      getBoundingClientRect: () => ({ top: 0, height: 40, left: 0, width: 300 }),
      contains: () => false,
      closest: () => null
    }
  }, overrides);
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function baseConfig(overrides = {}) {
  return {
    providers: [{
      id: 'p1', name: 'OpenAI production', baseUrl: 'https://api.openai.com/v1',
      key: '', hasKey: true, adapter: '', protocol: 'openai-images',
      models: ['alpha-model', 'beta-model'], names: { 'alpha-model': 'Alpha' }
    }],
    active: { providerId: 'p1', model: 'alpha-model' },
    defaults: {},
    ...overrides
  };
}

async function openProviderEditor(config, options = {}) {
  const harness = createHarness({ config, ...options });
  await settle();
  let tree = harness.renderRoot();
  const edit = findButton(tree, 'Edit');
  assert.ok(edit, 'expected the provider Edit button');
  edit.props.onClick();
  tree = harness.renderRoot();
  return { harness, tree };
}

test('the fetched model list pre-checks the models already in the catalog', async () => {
  const { harness, tree: edited } = await openProviderEditor(baseConfig());
  const fetchButton = findButton(edited, 'Fetch available models');
  assert.ok(fetchButton, 'expected the fetch-models button');
  await fetchButton.props.onClick();
  const tree = harness.renderRoot();

  assert.deepEqual(
    candidateRows(tree).map((candidate) => [candidate.id, candidate.checked]),
    [
      ['alpha-model', true],
      ['beta-model', true],
      ['gamma-model', false],
      ['delta-model', false]
    ]
  );
  assert.ok(harness.fetchCalls.some((call) => call.url.endsWith('/api/mo-image/models')));
});

test('adopting the selection rewrites the list and fills display names from the fetch', async () => {
  const { harness, tree: edited } = await openProviderEditor(baseConfig());
  await findButton(edited, 'Fetch available models').props.onClick();
  let tree = harness.renderRoot();

  // Uncheck a configured model, check one candidate the provider just listed.
  candidateRows(tree).find((candidate) => candidate.id === 'beta-model').toggle();
  tree = harness.renderRoot();
  candidateRows(tree).find((candidate) => candidate.id === 'gamma-model').toggle();
  tree = harness.renderRoot();

  const adopt = findButton(tree, 'Update list');
  assert.ok(adopt, 'expected the update-list button');
  adopt.props.onClick();
  tree = harness.renderRoot();

  assert.deepEqual(
    modelRows(tree).map((row) => ({ id: row.id, name: row.name })),
    [
      { id: 'alpha-model', name: 'Alpha' },
      { id: 'gamma-model', name: 'Gamma Model' }
    ]
  );
});

test('a fetch result without names leaves untouched rows and empty names alone', async () => {
  const { harness, tree: edited } = await openProviderEditor({
    providers: [{
      id: 'p1', name: 'Local', baseUrl: 'http://127.0.0.1:7860/v1',
      key: '', hasKey: false, adapter: 'a1111', protocol: 'openai-images',
      models: ['sdxl-base'], names: {}
    }],
    active: { providerId: 'p1', model: 'sdxl-base' },
    defaults: {}
  }, {
    adapters: [{ id: 'a1111', label: 'AUTOMATIC1111', supportsModels: true }],
    modelsResponse: { ok: true, models: ['sdxl-base'], allModels: ['sdxl-base'], filteredCount: 0 }
  });
  await findButton(edited, 'Fetch available models').props.onClick();
  const tree = harness.renderRoot();
  const adopt = findButton(tree, 'Update list');
  assert.ok(adopt);
  adopt.props.onClick();
  const after = harness.renderRoot();
  assert.deepEqual(modelRows(after).map((row) => ({ id: row.id, name: row.name })), [{ id: 'sdxl-base', name: '' }]);
});

test('model rows use the DSH field layout: drag handle, id field, delete, name field', async () => {
  const { tree } = await openProviderEditor(baseConfig());
  const rows = modelRows(tree);
  assert.equal(rows.length, 2);

  const first = rows[0];
  assert.equal(first.row.props['data-row-key'], '0');
  assert.ok(first.handle, 'expected a drag handle');
  assert.equal(first.handle.props.draggable, true);
  assert.match(first.handle.props['aria-label'], /Reorder model 1/);
  assert.equal(first.handle.props['aria-keyshortcuts'], 'ArrowUp ArrowDown');

  const idField = findAll(first.row, (node) => node.type === 'label' && hasClass(node, 'modelField'))[0];
  assert.ok(idField, 'expected the id field wrapper');
  assert.ok(!hasClass(idField, 'modelName'), 'the id field must not take the name column');
  assert.equal(findAll(idField, (node) => node.type === 'input')[0].props.value, 'alpha-model');

  const nameField = findAll(first.row, (node) => node.type === 'label' && hasClass(node, 'modelName'))[0];
  assert.ok(nameField, 'expected the name field in the name column');
  assert.equal(findAll(nameField, (node) => node.type === 'input')[0].props.value, 'Alpha');
  const nameLabel = findAll(nameField, (node) => hasClass(node, 'modelFieldLabel'))[0];
  assert.equal(textOf(nameLabel).join(''), 'Display name');

  const remove = findAll(first.row, (node) => node.type === 'button' && hasClass(node, 'iconButtonDanger'))[0];
  assert.ok(remove, 'expected the remove button');
});

test('dragging a row handle onto a lower row reorders the catalog', async () => {
  const { harness, tree: edited } = await openProviderEditor(baseConfig());
  assert.deepEqual(modelRows(edited).map((row) => row.id), ['alpha-model', 'beta-model']);

  modelRows(edited)[0].handle.props.onDragStart(fakeEvent());
  let tree = harness.renderRoot();
  const rows = modelRows(tree);
  assert.equal(rows[0].row.props['data-dragging'], true);

  // Drop past the middle of the second row: the dragged row lands after it.
  rows[1].row.props.onDrop(fakeEvent({ clientY: 39 }));
  tree = harness.renderRoot();
  assert.deepEqual(modelRows(tree).map((row) => row.id), ['beta-model', 'alpha-model']);
  assert.deepEqual(
    modelRows(tree).map((row) => row.name),
    ['', 'Alpha'],
    'names must travel with their model id'
  );
});

test('arrow keys on the drag handle move a row without a pointer', async () => {
  const { harness, tree: edited } = await openProviderEditor(baseConfig());
  modelRows(edited)[1].handle.props.onKeyDown(fakeEvent({ key: 'ArrowUp' }));
  const tree = harness.renderRoot();
  assert.deepEqual(modelRows(tree).map((row) => row.id), ['beta-model', 'alpha-model']);
});

function rowTags(tree) {
  return findAll(tree, (node) => hasClass(node, 'rowTag')).map((node) => textOf(node).join(''));
}

test('a provider built from a built-in preset carries no Custom tag', async () => {
  const harness = createHarness({ config: baseConfig() });
  await settle();
  const tree = harness.renderRoot();
  assert.deepEqual(rowTags(tree), [], 'a built-in provider is not a custom endpoint');
});

test('a provider with an endpoint of its own keeps the Custom tag', async () => {
  const config = baseConfig({
    providers: [{
      id: 'p1', name: 'My gateway', baseUrl: 'https://gateway.example.com/v1',
      key: '', hasKey: true, adapter: '', protocol: 'openai-images',
      models: ['alpha-model'], names: {}
    }],
    active: { providerId: 'p1', model: 'alpha-model' }
  });
  const harness = createHarness({ config });
  await settle();
  assert.deepEqual(rowTags(harness.renderRoot()), ['Custom']);
});

test('a local deployment still reads Local, not Custom', async () => {
  const config = baseConfig({
    providers: [{
      id: 'p1', name: 'AUTOMATIC1111', baseUrl: 'http://127.0.0.1:7860',
      key: '', hasKey: false, optionalKey: true, adapter: 'a1111', protocol: 'openai-images',
      models: ['sd-xl'], names: {}
    }],
    active: { providerId: 'p1', model: 'sd-xl' }
  });
  const harness = createHarness({ config });
  await settle();
  assert.deepEqual(rowTags(harness.renderRoot()), ['Local']);
});

test('the section header keeps DSH spacing: title row then intro as section children', async () => {
  const harness = createHarness({ config: baseConfig() });
  await settle();
  const tree = harness.renderRoot();

  const section = findAll(tree, (node) => hasClass(node, 'section'))[0];
  assert.ok(section, 'expected the settings section');
  const children = flattenChildren(section.children);
  // DSH renders <h2.title> and <p.intro> as siblings in the flex column section,
  // so the section's 12px gap separates them; nesting the intro would collapse it.
  const titleRow = children.findIndex((child) => findAll(child, (node) => node.type === 'h2' && hasClass(node, 'title')).length > 0);
  const introAt = children.findIndex((child) => child.type === 'p' && hasClass(child, 'intro'));
  assert.ok(titleRow >= 0, 'expected the title row');
  assert.equal(introAt, titleRow + 1, 'the intro must be a sibling of the title row');
  assert.equal(textOf(children[introAt]).join(''), 'Add a cloud API key, or connect to an image service on this machine or your local network.');
});

test('with DSH primitives present, the fetch dialog is the DSH Modal with outline buttons', async () => {
  const captured = { modal: null, buttons: [] };
  const primitives = {
    Modal: function Modal(props) {
      captured.modal = props;
      if (!props.open) return null;
      return {
        type: 'div',
        props: { 'data-dsh-modal': props.title, className: props.className },
        children: [props.children, props.footer]
      };
    },
    Button: function Button(props) {
      captured.buttons.push(props);
      return {
        type: 'button',
        props: { type: 'button', disabled: props.disabled, 'data-variant': props.variant, onClick: props.onClick },
        children: Array.isArray(props.children) ? props.children : [props.children]
      };
    },
    Tooltip: function Tooltip(props) { return props.children || null; },
    IconDragHandleOutlineRegular: function DragIcon() { return { type: 'svg', props: {}, children: [] }; }
  };

  const { harness, tree: edited } = await openProviderEditor(baseConfig(), { primitives });
  await findButton(edited, 'Fetch available models').props.onClick();
  const tree = harness.renderRoot();

  assert.ok(captured.modal, 'expected the DSH Modal to be used');
  assert.equal(captured.modal.title, 'Choose models');
  assert.equal(captured.modal.closeLabel, 'Close');
  assert.match(captured.modal.description, /Checked models make up the list/);
  assert.ok(captured.modal.className.endsWith('_fetchDialog'), captured.modal.className);
  assert.ok(!findAll(tree, (node) => node.props && node.props.role === 'dialog').length, 'the fallback portal must not render');

  const variants = captured.buttons.map((button) => button.variant);
  assert.deepEqual(variants.slice(-2), ['outline', 'outline']);
  const labels = captured.buttons.slice(-2).map((button) => button.children);
  assert.deepEqual(labels, ['Cancel', 'Update list']);

  // The row markup is shared with DSH: handle + id field + delete + name field.
  assert.equal(candidateRows(tree).length, 4);
  assert.equal(candidateRows(tree).filter((candidate) => candidate.checked).length, 2);
});

test('the protocol select lists every adapter and reveals the responses host model', async () => {
  const adapters = [
    { id: 'openai-responses', label: 'OpenAI Responses', local: false, supportsModels: false },
    { id: 'bfl', label: 'Black Forest Labs (FLUX)', local: false, supportsModels: true }
  ];
  const { harness, tree: edited } = await openProviderEditor(baseConfig(), { adapters });

  const protocolSelect = findAll(edited, (node) => node.type === 'select'
    && findAll(node, (child) => child.type === 'option').some((option) => option.props.value === 'bfl'))[0];
  assert.ok(protocolSelect, 'expected a protocol select that lists the adapters');
  assert.equal(protocolSelect.props.disabled, undefined);
  assert.deepEqual(
    findAll(protocolSelect, (child) => child.type === 'option').map((option) => option.props.value),
    ['', 'openai-responses', 'bfl']
  );
  assert.equal(findAll(edited, (node) => node.type === 'input' && node.props.value === 'gpt-5.2').length, 0);

  protocolSelect.props.onChange({ target: { value: 'openai-responses' } });
  const tree = harness.renderRoot();
  assert.ok(findAll(tree, (node) => node.type === 'input' && node.props.value === 'gpt-5.2').length > 0);
});
