import { describe, expect, it } from 'vitest';
import { createDesktopAPI, parseKeyCombo } from '../packages/core/src/desktop/index.js';
import { macActions } from '../packages/core/src/desktop/macos.js';
import { winActions } from '../packages/core/src/desktop/windows.js';
import type { DesktopAction, PlatformDriver } from '../packages/core/src/desktop/types.js';

/** 最小 PNG 头：只需 IHDR 里的宽高即可让 API 计算比例。 */
const png = (width: number, height: number) => {
  const buffer = Buffer.alloc(33, 0);
  buffer.write('\x89PNG\r\n\x1a\n', 0, 'binary'); buffer.writeUInt32BE(13, 8); buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16); buffer.writeUInt32BE(height, 20); return buffer;
};
const fakeDriver = (points = {width: 100, height: 50}, pixels = {width: 200, height: 100}) => {
  const calls: DesktopAction[][] = [];
  const driver: PlatformDriver = {
    platform: 'darwin',
    async run(actions) {
      calls.push(actions);
      return actions.map(action => action.type === 'screen' ? {...points, screenRecording: true, accessibility: false}
        : action.type === 'frontmost' || action.type === 'open' || action.type === 'focus' ? 'Finder' : action.type === 'windows' ? [{app: 'Finder', title: 'Desktop', x: 0, y: 0, width: 10, height: 10, focused: true}] : null);
    },
    async capture() {return png(pixels.width, pixels.height);},
  };
  return {driver, calls};
};

describe('desktop layer', () => {
  it('parses key combos into modifiers + key and translates them per platform', () => {
    expect(parseKeyCombo('cmd+Shift+T')).toEqual({modifiers: ['cmd', 'shift'], key: 't'});
    expect(parseKeyCombo('Return')).toEqual({modifiers: [], key: 'enter'});
    expect(parseKeyCombo('ctrl+alt+Delete')).toEqual({modifiers: ['ctrl', 'alt'], key: 'delete'});
    expect(() => parseKeyCombo('bogus+x')).toThrow('未知修饰键');
    const combo: DesktopAction = {type: 'key', combo: parseKeyCombo('cmd+space')};
    expect(macActions([combo])).toEqual([{type: 'key', code: 49, using: ['command down']}]);
    expect(winActions([combo])).toEqual([{type: 'key', code: 0x20, modifiers: [0x11]}]);
    expect(() => macActions([{type: 'key', combo: parseKeyCombo('cmd+f19')}])).toThrow('不支持按键');
  });
  it('converts screenshot pixels to system coordinates, validates input and reports permissions', async () => {
    const {driver, calls} = fakeDriver();
    const shots: number[] = [];
    const desktop = createDesktopAPI(driver, shot => shots.push(shot.png.length));
    // 未截图就点击：先自动截图确定比例（200px / 100pt = 2），再换算。
    await desktop.click(50, 20);
    expect(shots).toHaveLength(1);
    expect(calls.at(-1)).toEqual([{type: 'click', x: 25, y: 10, button: 'left', count: 1}]);
    const info = await desktop.screenshot();
    expect(info).toMatchObject({width: 200, height: 100, scale: 2, platform: 'darwin', permissions: {screenRecording: true, accessibility: false}});
    expect('png' in info).toBe(false);
    await desktop.doubleClick(10, 10); expect(calls.at(-1)?.[0]).toMatchObject({count: 2, button: 'left'});
    await desktop.rightClick(10, 10); expect(calls.at(-1)?.[0]).toMatchObject({button: 'right'});
    await desktop.drag(0, 0, 200, 100); expect(calls.at(-1)).toEqual([{type: 'drag', x1: 0, y1: 0, x2: 100, y2: 50}]);
    await desktop.scroll(100, 50, 40); expect(calls.at(-1)).toEqual([{type: 'scroll', x: 50, y: 25, dy: 20, dx: 0}]);
    await expect(desktop.click(500, 10)).rejects.toThrow('超出屏幕范围');
    await expect(desktop.click(Number.NaN, 10)).rejects.toThrow('必须是数字');
    await expect(desktop.type('')).rejects.toThrow('非空字符串');
    await expect(desktop.key('x'.repeat(65))).rejects.toThrow('过长');
    await desktop.type('héllo 世界'); expect(calls.at(-1)).toEqual([{type: 'type', text: 'héllo 世界'}]);
    await desktop.key('cmd+v'); expect(calls.at(-1)).toEqual([{type: 'key', combo: {modifiers: ['cmd'], key: 'v'}}]);
    expect(await desktop.open('Notes')).toEqual({frontmostApp: 'Finder'}); expect(calls.at(-1)).toEqual([{type: 'open', name: 'Notes'}]);
    expect(await desktop.focus('Notes')).toEqual({frontmostApp: 'Finder'});
    expect(await desktop.windows()).toEqual([{app: 'Finder', title: 'Desktop', x: 0, y: 0, width: 10, height: 10, focused: true}]);
  });
  it('offsets coordinates by the captured display origin on multi-monitor setups', async () => {
    const {driver, calls} = fakeDriver();
    const shifted: PlatformDriver = {...driver, async run(actions) {
      const out = await driver.run(actions);
      return out.map((v, i) => actions[i].type === 'screen' ? {...(v as object), originX: -1000, originY: 40, display: 2, displays: 2} : v);
    }};
    const desktop = createDesktopAPI(shifted);
    expect(await desktop.screenshot()).toMatchObject({display: 2, displays: 2, origin: {x: -1000, y: 40}});
    await desktop.click(50, 20); expect(calls.at(-1)).toEqual([{type: 'click', x: -975, y: 50, button: 'left', count: 1}]);
  });
  it('uses JXA property syntax for zero-argument ObjC calls (clearContents() throws at runtime)', async () => {
    const {macScript} = await import('../packages/core/src/desktop/macos.js');
    expect(macScript).not.toMatch(/pb\.clearContents\(\);/);
    expect(macScript).toMatch(/pb\.clearContents;/);
  });
  it('treats an unscaled display as scale 1 and rejects non-PNG captures', async () => {
    const {driver, calls} = fakeDriver({width: 640, height: 480}, {width: 640, height: 480});
    const desktop = createDesktopAPI(driver);
    await desktop.move(320, 240); expect(calls.at(-1)).toEqual([{type: 'move', x: 320, y: 240}]);
    const broken = createDesktopAPI({...driver, capture: async () => Buffer.from('not a png')});
    await expect(broken.screenshot()).rejects.toThrow('有效的 PNG');
  });
});
