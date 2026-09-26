/**
 * 设置面板。
 *
 * 界面完全由 data/settings.js 的 schema 驱动：这个文件不认识「名称」「版本」
 * 或任何具体设置项，只认 text / toggle / action 三种字段类型。
 * 以后加设置项只需要改 schema，这里不用动。
 *
 * 外壳（遮罩 / 滑入 / inert / 关闭）在 views/drawer.js，与历史记录共用。
 */

import { el } from '../core/dom.js';
import { SETTINGS_SCHEMA } from '../data/settings.js';
import { clearAssignments, setAppInfo, setPref } from '../core/actions.js';
import { createDrawer } from './drawer.js';
import { createConfirmButton } from './confirm-button.js';

const ACTIONS = {
  clearAssignments: (store) => clearAssignments(store),
};

export function createSettingsPanel({ store, mount }) {
  const drawer = createDrawer({ title: '设置', variant: 'settings', mount });
  const body = drawer.body;

  const dynamicDescs = [];
  for (const section of SETTINGS_SCHEMA) body.append(renderSection(section));

  const open = drawer.open;
  const close = drawer.close;

  /* ---------------------------------------------------------------- 分区 */

  function renderSection(section) {
    const desc = el('p', { class: 'set-section__desc' });
    dynamicDescs.push({ node: desc, source: section.desc });

    const read = (key) => store.getState()[section.store]?.[key];
    const write = section.store === 'prefs'
      ? (key, value) => setPref(store, key, value)
      : (key, value) => setAppInfo(store, key, value);

    const fields = el('div', { class: 'set-fields' });
    for (const field of section.fields) fields.append(renderField(section, field, read, write));

    return el('section', { class: 'set-section' }, [
      el('h3', { class: 'set-section__title', text: section.title }),
      desc,
      fields,
    ]);
  }

  function renderField(section, field, read, write) {
    if (field.type === 'text') return renderText(section, field, read, write);
    if (field.type === 'toggle') return renderToggle(field, read, write);
    if (field.type === 'action') return renderAction(field);
    return document.createComment(`未知设置项类型：${field.type}`);
  }

  function renderText(section, field, read, write) {
    const id = `set-${section.id}-${field.key}`;
    const input = el('input', {
      class: 'input',
      type: 'text',
      id,
      placeholder: field.placeholder ?? '',
      maxlength: field.maxLength,
      autocomplete: 'off',
      spellcheck: 'false',
    });
    input.value = read(field.key) ?? '';
    input.addEventListener('input', () => write(field.key, input.value));

    return el('div', { class: 'field' }, [
      el('label', { class: 'field__label', for: id, text: field.label }),
      input,
    ]);
  }

  function renderToggle(field, read, write) {
    const control = el('button', {
      class: 'switch',
      type: 'button',
      role: 'switch',
      'aria-label': field.label,
      'aria-checked': String(read(field.key) === true),
      on: { click: () => write(field.key, read(field.key) !== true) },
    }, [
      el('span', { class: 'switch__track' }, [el('span', { class: 'switch__thumb' })]),
    ]);

    // schema 改完值以后开关自己刷新状态，不必等整块重渲染
    store.subscribe(() => {
      control.setAttribute('aria-checked', String(read(field.key) === true));
    });

    return el('div', { class: 'field' }, [
      el('span', { class: 'field__label', text: field.label }),
      el('div', { class: 'switch-row' }, [
        control,
        field.hint ? el('span', { class: 'switch__hint', text: field.hint }) : null,
      ]),
    ]);
  }

  function renderAction(field) {
    const { button } = createConfirmButton({
      label: field.label,
      confirmLabel: field.confirmLabel,
      className: `btn btn--block${field.tone === 'danger' ? ' btn--danger' : ''}`,
      onConfirm: () => ACTIONS[field.action]?.(store),
    });

    return button;
  }

  /* -------------------------------------------------------------- 同步 */

  function syncDescs(state) {
    for (const { node, source } of dynamicDescs) {
      node.textContent = typeof source === 'function' ? source(state) : source;
    }
  }

  store.subscribe(syncDescs);
  syncDescs(store.getState());

  return { open, close, isOpen: drawer.isOpen };
}
