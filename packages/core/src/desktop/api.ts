// 把平台驱动包装成 exec_js 里的 `desktop` 对象：负责坐标换算、参数校验、截图回显。
import { parseKeyCombo } from './keys.js';
import type { DesktopAPI, DesktopScreenshot, DesktopWindow, MouseButton, PlatformDriver, ScreenInfo } from './types.js';

const pngSize = (png: Buffer) => {
  if (png.length < 24 || png.toString('ascii', 1, 4) !== 'PNG') throw new Error('桌面截图不是有效的 PNG。');
  return {width: png.readUInt32BE(16), height: png.readUInt32BE(20)};
};
const finite = (value: unknown, name: string) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} 必须是数字。`);
  return value;
};
const text = (value: unknown, name: string, max = 20_000) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 必须是非空字符串。`);
  if (value.length > max) throw new Error(`${name} 过长（上限 ${max} 字符）。`);
  return value;
};

/**
 * @param driver 平台驱动
 * @param onScreenshot 每次截图的回调（worker 用它把图片回显给模型并存档）
 */
export function createDesktopAPI(driver: PlatformDriver, onScreenshot?: (shot: DesktopScreenshot) => void): DesktopAPI & {capture(): Promise<DesktopScreenshot>} {
  let scale: number | undefined;
  let lastScreen: ScreenInfo | undefined;

  type RawScreen = {width: number; height: number; originX?: number; originY?: number; display?: number; displays?: number; screenRecording: boolean | 'unknown'; accessibility: boolean | 'unknown'};
  const fromRaw = (info: RawScreen, size: {width: number; height: number}, current: number): ScreenInfo => ({
    ...size, scale: current, platform: driver.platform, display: info.display ?? 1, displays: info.displays ?? 1,
    origin: {x: info.originX ?? 0, y: info.originY ?? 0}, permissions: {screenRecording: info.screenRecording, accessibility: info.accessibility},
  });
  const screen = async (): Promise<ScreenInfo> => {
    const [info] = await driver.run([{type: 'screen'}]) as RawScreen[];
    const current = scale ?? 1;
    lastScreen = fromRaw(info, {width: Math.round(info.width * current), height: Math.round(info.height * current)}, current);
    return lastScreen;
  };
  const capture = async (): Promise<DesktopScreenshot> => {
    const [png, [info, frontmost]] = await Promise.all([
      driver.capture(),
      driver.run([{type: 'screen'}, {type: 'frontmost'}]) as Promise<[RawScreen, string]>,
    ]);
    const size = pngSize(png);
    scale = info.width > 0 ? size.width / info.width : 1;
    lastScreen = fromRaw(info, size, scale);
    const shot = {...lastScreen, png, frontmostApp: frontmost || undefined};
    onScreenshot?.(shot);
    return shot;
  };
  /** 截图像素 → 系统坐标；尚未截图时先截一张确定比例。 */
  const toPoint = async (x: number, y: number) => {
    if (scale === undefined) await capture();
    if (!lastScreen || x < 0 || y < 0 || x > lastScreen.width || y > lastScreen.height) throw new Error(`坐标 (${x}, ${y}) 超出屏幕范围 ${lastScreen?.width ?? '?'}×${lastScreen?.height ?? '?'}。`);
    return {x: x / scale! + lastScreen.origin.x, y: y / scale! + lastScreen.origin.y};
  };
  const click = async (x: number, y: number, options: {button?: MouseButton; count?: number} = {}) => {
    const button = options.button ?? 'left';
    if (!['left', 'right', 'middle'].includes(button)) throw new Error('button 必须是 left / right / middle。');
    const count = Math.min(3, Math.max(1, Math.round(options.count ?? 1)));
    const point = await toPoint(finite(x, 'x'), finite(y, 'y'));
    await driver.run([{type: 'click', ...point, button, count}]);
  };

  return {
    capture,
    async screenshot() {const shot = await capture(); const {png: _png, ...info} = shot; return info;},
    screen,
    async move(x, y) {await driver.run([{type: 'move', ...await toPoint(finite(x, 'x'), finite(y, 'y'))}]);},
    click,
    doubleClick: (x, y) => click(x, y, {count: 2}),
    rightClick: (x, y) => click(x, y, {button: 'right'}),
    async drag(x1, y1, x2, y2) {
      const from = await toPoint(finite(x1, 'x1'), finite(y1, 'y1')); const to = await toPoint(finite(x2, 'x2'), finite(y2, 'y2'));
      await driver.run([{type: 'drag', x1: from.x, y1: from.y, x2: to.x, y2: to.y}]);
    },
    async scroll(x, y, dy, dx = 0) {
      const point = await toPoint(finite(x, 'x'), finite(y, 'y'));
      await driver.run([{type: 'scroll', ...point, dy: Math.round(finite(dy, 'dy') / (scale ?? 1)), dx: Math.round(finite(dx, 'dx') / (scale ?? 1))}]);
    },
    async type(value) {await driver.run([{type: 'type', text: text(value, 'text')}]);},
    async key(combo) {await driver.run([{type: 'key', combo: parseKeyCombo(text(combo, 'key', 64))}]);},
    async open(app) {const [front] = await driver.run([{type: 'open', name: text(app, 'app', 200)}]); return {frontmostApp: typeof front === 'string' ? front : ''};},
    async focus(app) {const [front] = await driver.run([{type: 'focus', name: text(app, 'app', 200)}]); return {frontmostApp: typeof front === 'string' ? front : ''};},
    async windows() {
      const [list] = await driver.run([{type: 'windows'}]) as [DesktopWindow[]];
      return (Array.isArray(list) ? list : []).slice(0, 200);
    },
  };
}
