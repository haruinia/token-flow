// 桌面层公共类型：让 Agent 像操作浏览器一样操作 Windows / macOS 桌面软件。
// 坐标统一使用「最近一次截图的像素坐标」，各平台驱动自行换算到系统坐标（macOS Retina 为 points）。

export type MouseButton = 'left' | 'right' | 'middle';
export type Modifier = 'cmd' | 'ctrl' | 'alt' | 'shift' | 'win';
export type KeyCombo = {modifiers: Modifier[]; key: string};

export type ScreenInfo = {
  /** 截图像素尺寸。 */
  width: number; height: number;
  /** 截图像素 / 系统坐标 的比例（macOS Retina 通常为 2，Windows 为 1）。 */
  scale: number;
  platform: 'darwin' | 'win32';
  /** 截图对应的显示器（1 = 主显示器）以及显示器总数；多显示器时截前台窗口所在的那块屏。 */
  display: number; displays: number;
  /** 该显示器左上角在系统坐标里的位置，截图像素坐标换算成系统坐标时要加上。 */
  origin: {x: number; y: number};
  /** 系统权限状态；缺失时对应操作会静默失败，需要提示用户到系统设置授权。 */
  permissions: {screenRecording: boolean | 'unknown'; accessibility: boolean | 'unknown'};
};
export type DesktopScreenshot = ScreenInfo & {png: Buffer; frontmostApp?: string};
export type DesktopWindow = {app: string; title: string; x: number; y: number; width: number; height: number; focused: boolean};

/** 一次 osascript / powershell 调用中顺序执行的原子动作，坐标已是系统坐标。 */
export type DesktopAction =
  | {type: 'screen'}
  /** 查询权限；prompt 为 true 时触发系统授权弹窗（macOS 辅助功能 / 屏幕录制）。 */
  | {type: 'permissions'; prompt: boolean}
  | {type: 'move'; x: number; y: number}
  | {type: 'click'; x: number; y: number; button: MouseButton; count: number}
  | {type: 'drag'; x1: number; y1: number; x2: number; y2: number}
  | {type: 'scroll'; x: number; y: number; dx: number; dy: number}
  | {type: 'key'; combo: KeyCombo}
  | {type: 'type'; text: string}
  | {type: 'open'; name: string}
  | {type: 'focus'; name: string}
  | {type: 'windows'}
  | {type: 'frontmost'};

/** 平台驱动只负责两件事：执行动作序列、截图。 */
export type PlatformDriver = {
  platform: 'darwin' | 'win32';
  run(actions: DesktopAction[]): Promise<unknown[]>;
  /** 返回主显示器 PNG。 */
  capture(): Promise<Buffer>;
};

/** 暴露给 exec_js 的 `desktop` 对象。 */
export type DesktopAPI = {
  screenshot(): Promise<ScreenInfo>;
  move(x: number, y: number): Promise<void>;
  click(x: number, y: number, options?: {button?: MouseButton; count?: number}): Promise<void>;
  doubleClick(x: number, y: number): Promise<void>;
  rightClick(x: number, y: number): Promise<void>;
  drag(x1: number, y1: number, x2: number, y2: number): Promise<void>;
  scroll(x: number, y: number, dy: number, dx?: number): Promise<void>;
  type(text: string): Promise<void>;
  key(combo: string): Promise<void>;
  open(app: string): Promise<{frontmostApp: string}>;
  focus(app: string): Promise<{frontmostApp: string}>;
  windows(): Promise<DesktopWindow[]>;
  screen(): Promise<ScreenInfo>;
};
