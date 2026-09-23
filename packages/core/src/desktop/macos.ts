// macOS 驱动：零依赖。输入事件通过 osascript 的 JXA + ObjC 桥直接投递 CGEvent，
// 截图用系统自带 screencapture。需要用户在「系统设置 → 隐私与安全性」为本应用授予
// 「辅助功能」（输入）和「屏幕录制」（截图）。
import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { macKeyCodes } from './keys.js';
import type { DesktopAction, PlatformDriver } from './types.js';

const execFileAsync = promisify(execFile);
const modifierNames: Record<string, string> = {cmd: 'command down', ctrl: 'control down', alt: 'option down', shift: 'shift down', win: 'command down'};

/** 把结构化动作翻译成 JXA 可直接消费的 JSON（键名换成 macOS 键码 / System Events 修饰词）。 */
export function macActions(actions: DesktopAction[]) {
  return actions.map(action => {
    if (action.type !== 'key') return action;
    const code = macKeyCodes[action.combo.key];
    if (code === undefined) throw new Error(`macOS 不支持按键 "${action.combo.key}"。`);
    return {type: 'key', code, using: action.combo.modifiers.map(m => modifierNames[m])};
  });
}

// 常量用数字而不是 $.kCG*，避免 JXA 桥对枚举的解析差异。
// 鼠标事件类型：move 5 / leftDown 1 leftUp 2 leftDrag 6 / rightDown 3 rightUp 4 rightDrag 7 / otherDown 25 otherUp 26 otherDrag 27
export const macScript = String.raw`
ObjC.import('CoreGraphics'); ObjC.import('AppKit'); ObjC.import('ApplicationServices');
function run(argv) {
  const actions = JSON.parse(argv[0]); const out = [];
  const sleep = s => $.NSThread.sleepForTimeInterval(s);
  const post = ev => $.CGEventPost(0, ev);
  const buttons = {left: [0, 1, 2, 6], right: [1, 3, 4, 7], middle: [2, 25, 26, 27]};
  const mouse = (type, x, y, button, clicks) => {
    const ev = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), button);
    if (clicks) $.CGEventSetIntegerValueField(ev, 1, clicks);
    post(ev);
  };
  const se = () => Application('System Events');
  // 先走 LaunchServices：未运行则启动，已运行但没有窗口时会收到 reopen 重新开窗（单纯 activate 不会）。
  const activate = name => {
    if ($.NSWorkspace.sharedWorkspace.launchApplication($(name))) return;
    try { Application(name).activate(); } catch (e) { throw new Error('找不到应用：' + name); }
  };
  for (const a of actions) {
    switch (a.type) {
      case 'screen': {
        // 多显示器：取前台应用窗口所在的显示器（找不到则主显示器）。坐标换成 CG 坐标系（主屏左上角为原点，y 向下）。
        const screens = $.NSScreen.screens; const mainH = $.NSScreen.screens.objectAtIndex(0).frame.size.height;
        const displays = [];
        for (let i = 0; i < screens.count; i++) { const f = screens.objectAtIndex(i).frame; displays.push({index: i + 1, x: f.origin.x, y: mainH - f.origin.y - f.size.height, width: f.size.width, height: f.size.height}); }
        let target = displays[0];
        try {
          const front = se().applicationProcesses.whose({frontmost: true})()[0]; const w = front.windows()[0]; const pos = w.position(), size = w.size();
          const cx = pos[0] + size[0] / 2, cy = pos[1] + size[1] / 2;
          target = displays.find(d => cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height) || target;
        } catch (e) {}
        let screen = 'unknown', accessibility = 'unknown';
        try { ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]); screen = !!$.CGPreflightScreenCaptureAccess(); } catch (e) {}
        try { accessibility = !!$.AXIsProcessTrusted(); } catch (e) {}
        out.push({width: target.width, height: target.height, originX: target.x, originY: target.y, display: target.index, displays: displays.length, screenRecording: screen, accessibility}); break;
      }
      case 'permissions': {
        let screen = 'unknown', accessibility = 'unknown';
        try {
          ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]); ObjC.bindFunction('CGRequestScreenCaptureAccess', ['bool', []]);
          screen = !!$.CGPreflightScreenCaptureAccess(); if (!screen && a.prompt) screen = !!$.CGRequestScreenCaptureAccess();
        } catch (e) {}
        try { accessibility = a.prompt ? !!$.AXIsProcessTrustedWithOptions($({AXTrustedCheckOptionPrompt: true})) : !!$.AXIsProcessTrusted(); } catch (e) {}
        out.push({screenRecording: screen, accessibility}); break;
      }
      case 'move': mouse(5, a.x, a.y, 0); break;
      case 'click': {
        const b = buttons[a.button]; mouse(5, a.x, a.y, 0); sleep(0.03);
        for (let i = 1; i <= a.count; i++) { mouse(b[1], a.x, a.y, b[0], i); sleep(0.01); mouse(b[2], a.x, a.y, b[0], i); sleep(0.05); }
        break;
      }
      case 'drag': {
        mouse(5, a.x1, a.y1, 0); sleep(0.05); mouse(1, a.x1, a.y1, 0, 1); sleep(0.15);
        for (let i = 1; i <= 12; i++) { mouse(6, a.x1 + (a.x2 - a.x1) * i / 12, a.y1 + (a.y2 - a.y1) * i / 12, 0); sleep(0.02); }
        sleep(0.1); mouse(2, a.x2, a.y2, 0, 1); break;
      }
      case 'scroll': {
        mouse(5, a.x, a.y, 0);
        const ev = $.CGEventCreate(null); $.CGEventSetType(ev, 22); $.CGEventSetLocation(ev, $.CGPointMake(a.x, a.y));
        $.CGEventSetIntegerValueField(ev, 88, 1); // 连续（像素）滚动
        $.CGEventSetIntegerValueField(ev, 96, -a.dy); $.CGEventSetIntegerValueField(ev, 97, -a.dx);
        $.CGEventSetIntegerValueField(ev, 11, -Math.round(a.dy / 10)); $.CGEventSetIntegerValueField(ev, 12, -Math.round(a.dx / 10));
        post(ev); break;
      }
      case 'key': if (a.using.length) se().keyCode(a.code, {using: a.using}); else se().keyCode(a.code); break;
      case 'type': {
        // 通过剪贴板粘贴，Unicode 安全；结束后恢复原剪贴板文本。
        // JXA 的 ObjC 桥把无参方法当属性：必须写 pb.clearContents 而不是 pb.clearContents()。
        const pb = $.NSPasteboard.generalPasteboard; const old = pb.stringForType($.NSPasteboardTypeString);
        pb.clearContents; pb.setStringForType($(a.text), $.NSPasteboardTypeString); sleep(0.05);
        se().keystroke('v', {using: ['command down']}); sleep(0.2);
        pb.clearContents; if (!old.isNil()) pb.setStringForType(old, $.NSPasteboardTypeString);
        break;
      }
      case 'open': case 'focus': {
        activate(a.name); sleep(0.5);
        const app = $.NSWorkspace.sharedWorkspace.frontmostApplication; out.push(app.isNil() ? '' : app.localizedName.js); break;
      }
      case 'windows': {
        const list = []; const procs = se().applicationProcesses.whose({backgroundOnly: false})();
        for (const p of procs) { let name = '', front = false; try { name = p.name(); front = p.frontmost(); } catch (e) { continue; }
          let windows = []; try { windows = p.windows(); } catch (e) {}
          for (const w of windows) { try { const pos = w.position(), size = w.size(); list.push({app: name, title: w.name() || '', x: pos[0], y: pos[1], width: size[0], height: size[1], focused: front}); } catch (e) {} } }
        out.push(list); break;
      }
      case 'frontmost': { const app = $.NSWorkspace.sharedWorkspace.frontmostApplication; out.push(app.isNil() ? '' : app.localizedName.js); break; }
      default: throw new Error('未知桌面动作：' + a.type);
    }
    sleep(0.02);
  }
  return JSON.stringify(out);
}`;

export function createMacDriver(): PlatformDriver {
  return {
    platform: 'darwin',
    async run(actions) {
      const payload = JSON.stringify(macActions(actions));
      const {stdout} = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', macScript, payload], {timeout: 30_000, maxBuffer: 4 * 1024 * 1024}).catch((error: Error & {stderr?: string}) => {
        throw new Error(`桌面操作失败：${(error.stderr || error.message).replace(/^execution error:\s*/i, '').trim().slice(0, 500)}`);
      });
      return JSON.parse(stdout.trim() || '[]') as unknown[];
    },
    async capture() {
      const path = join(tmpdir(), `agent-desktop-${randomUUID()}.png`);
      try {
        // -x 静音 -D n 只截前台窗口所在的显示器；老系统不支持 -D 时退回全部显示器（多显示器会生成多张，只读第一张）。
        const [screen] = await this.run([{type: 'screen'}]) as [{width: number; display?: number}];
        await execFileAsync('screencapture', ['-x', '-t', 'png', '-D', String(screen?.display || 1), path], {timeout: 15_000})
          .catch(() => execFileAsync('screencapture', ['-x', '-t', 'png', path], {timeout: 15_000}));
        // Retina 截图按 points 重采样：图片更小，且截图像素 == 系统坐标（scale = 1）。
        if (screen?.width > 0) await execFileAsync('sips', ['--resampleWidth', String(Math.round(screen.width)), path], {timeout: 15_000}).catch(() => undefined);
        return await readFile(path);
      } catch (error) {
        throw new Error(`桌面截图失败：${error instanceof Error ? error.message.slice(0, 300) : '未知错误'}`);
      } finally {await rm(path, {force: true}).catch(() => undefined);}
    },
  };
}
