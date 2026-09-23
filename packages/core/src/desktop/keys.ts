import type { KeyCombo, Modifier } from './types.js';

const modifierAliases: Record<string, Modifier> = {
  cmd: 'cmd', command: 'cmd', meta: 'cmd', super: 'cmd',
  ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', opt: 'alt', shift: 'shift', win: 'win', windows: 'win',
};
const keyAliases: Record<string, string> = {
  return: 'enter', esc: 'escape', del: 'delete', backspace: 'backspace', bs: 'backspace', spacebar: 'space',
  pgup: 'pageup', pgdn: 'pagedown', pgdown: 'pagedown', arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
};

/** 'cmd+shift+t' / 'Enter' / 'ctrl+alt+delete' → 结构化组合键。 */
export function parseKeyCombo(input: string): KeyCombo {
  const parts = input.split('+').map(part => part.trim()).filter(Boolean);
  if (!parts.length) throw new Error('key 需要形如 "cmd+shift+t" 或 "enter" 的按键描述。');
  // 除最后一段外都必须是修饰键；最后一段是主键（单字符保留大小写，其余小写）。
  const modifiers = parts.slice(0, -1).map(part => {
    const modifier = modifierAliases[part.toLowerCase()];
    if (!modifier) throw new Error(`未知修饰键 "${part}"：${input}`);
    return modifier;
  });
  const last = parts[parts.length - 1];
  const lower = last.toLowerCase();
  const key = keyAliases[lower] ?? (last.length === 1 ? last.toLowerCase() : lower);
  return {modifiers: [...new Set(modifiers)], key};
}

/** macOS ANSI 虚拟键码（与键盘布局无关的物理键）。 */
export const macKeyCodes: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '=': 24, '9': 25, '7': 26, '-': 27, '8': 28, '0': 29,
  ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, enter: 36, l: 37, j: 38, "'": 39, k: 40, ';': 41, '\\': 42, ',': 43,
  '/': 44, n: 45, m: 46, '.': 47, tab: 48, space: 49, '`': 50, backspace: 51, escape: 53,
  cmd: 55, shift: 56, capslock: 57, alt: 58, ctrl: 59,
  f5: 96, f6: 97, f7: 98, f3: 99, f8: 100, f9: 101, f11: 103, f13: 105, f14: 107, f10: 109, f12: 111, f15: 113,
  home: 115, pageup: 116, delete: 117, f4: 118, end: 119, f2: 120, pagedown: 121, f1: 122, left: 123, right: 124, down: 125, up: 126,
};

/** Windows 虚拟键码。 */
export const winKeyCodes: Record<string, number> = {
  backspace: 0x08, tab: 0x09, enter: 0x0d, shift: 0x10, ctrl: 0x11, alt: 0x12, capslock: 0x14, escape: 0x1b, space: 0x20,
  pageup: 0x21, pagedown: 0x22, end: 0x23, home: 0x24, left: 0x25, up: 0x26, right: 0x27, down: 0x28, printscreen: 0x2c, insert: 0x2d, delete: 0x2e,
  win: 0x5b, cmd: 0x11, ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
  ...Object.fromEntries(Array.from({length: 12}, (_, i) => [`f${i + 1}`, 0x70 + i])),
  ...Object.fromEntries(Array.from({length: 10}, (_, i) => [String(i), 0x30 + i])),
  ...Object.fromEntries(Array.from({length: 26}, (_, i) => [String.fromCharCode(97 + i), 0x41 + i])),
};
