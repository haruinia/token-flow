// Windows 驱动：零依赖。PowerShell + user32 P/Invoke 投递鼠标键盘事件，System.Drawing 截图。
// 进程声明 DPI 感知，因此截图像素与 SetCursorPos 坐标一致（scale = 1）。
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { winKeyCodes } from './keys.js';
import type { DesktopAction, PlatformDriver } from './types.js';

const execFileAsync = promisify(execFile);
const modifierCodes: Record<string, number> = {cmd: 0x11, ctrl: 0x11, alt: 0x12, shift: 0x10, win: 0x5b};

export function winActions(actions: DesktopAction[]) {
  return actions.map(action => {
    if (action.type !== 'key') return action;
    const code = winKeyCodes[action.combo.key];
    if (code === undefined) throw new Error(`Windows 不支持按键 "${action.combo.key}"。`);
    return {type: 'key', code, modifiers: action.combo.modifiers.map(m => modifierCodes[m])};
  });
}

export const winScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type -Namespace Agent -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@
[Agent.Native]::SetProcessDPIAware() | Out-Null
$actions = [IO.File]::ReadAllText($env:AGENT_DESKTOP_ACTIONS) | ConvertFrom-Json
$out = New-Object System.Collections.ArrayList
function Down($vk) { [Agent.Native]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero) }
function Up($vk) { [Agent.Native]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero) }
function MouseTo($x, $y) { [Agent.Native]::SetCursorPos([int]$x, [int]$y) | Out-Null; Start-Sleep -Milliseconds 20 }
$buttons = @{ left = @(0x2, 0x4); right = @(0x8, 0x10); middle = @(0x20, 0x40) }
function Windows() {
  $list = New-Object System.Collections.ArrayList
  $front = [Agent.Native]::GetForegroundWindow()
  foreach ($p in Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle }) {
    $r = New-Object Agent.Native+RECT
    if ([Agent.Native]::GetWindowRect($p.MainWindowHandle, [ref]$r)) {
      [void]$list.Add(@{ app = $p.ProcessName; title = $p.MainWindowTitle; x = $r.Left; y = $r.Top; width = $r.Right - $r.Left; height = $r.Bottom - $r.Top; focused = ($p.MainWindowHandle -eq $front) })
    }
  }
  return $list
}
foreach ($a in $actions) {
  switch ($a.type) {
    'screen' { $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; [void]$out.Add(@{ width = $b.Width; height = $b.Height; screenRecording = $true; accessibility = $true }) }
    'permissions' { [void]$out.Add(@{ screenRecording = $true; accessibility = $true }) }
    'capture' {
      $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
      $bmp.Save($a.path, [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
    }
    'move' { MouseTo $a.x $a.y }
    'click' { MouseTo $a.x $a.y; $f = $buttons[$a.button]; for ($i = 0; $i -lt $a.count; $i++) { [Agent.Native]::mouse_event($f[0], 0, 0, 0, [UIntPtr]::Zero); [Agent.Native]::mouse_event($f[1], 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60 } }
    'drag' { MouseTo $a.x1 $a.y1; [Agent.Native]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 150
      for ($i = 1; $i -le 12; $i++) { MouseTo ($a.x1 + ($a.x2 - $a.x1) * $i / 12) ($a.y1 + ($a.y2 - $a.y1) * $i / 12) }
      Start-Sleep -Milliseconds 100; [Agent.Native]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero) }
    'scroll' { MouseTo $a.x $a.y; if ($a.dy) { [Agent.Native]::mouse_event(0x800, 0, 0, [uint32](([int](-$a.dy)) -band 0xFFFFFFFF), [UIntPtr]::Zero) }; if ($a.dx) { [Agent.Native]::mouse_event(0x1000, 0, 0, [uint32](([int]$a.dx) -band 0xFFFFFFFF), [UIntPtr]::Zero) } }
    'key' { foreach ($m in $a.modifiers) { Down $m }; Down $a.code; Start-Sleep -Milliseconds 20; Up $a.code; foreach ($m in $a.modifiers) { Up $m } }
    'type' { $old = Get-Clipboard -Raw -ErrorAction SilentlyContinue; Set-Clipboard -Value $a.text; Start-Sleep -Milliseconds 50; Down 0x11; Down 0x56; Up 0x56; Up 0x11; Start-Sleep -Milliseconds 200; if ($null -ne $old) { Set-Clipboard -Value $old } }
    { $_ -in 'open', 'focus' } {
      $p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -ieq $a.name -or $_.MainWindowTitle -ilike "*$($a.name)*") } | Select-Object -First 1
      if ($p) { [Agent.Native]::ShowWindow($p.MainWindowHandle, 9) | Out-Null; [Agent.Native]::SetForegroundWindow($p.MainWindowHandle) | Out-Null }
      elseif ($a.type -eq 'open') { Start-Process $a.name | Out-Null; Start-Sleep -Milliseconds 800 }
      else { throw "找不到窗口：$($a.name)" }
      $front = [Agent.Native]::GetForegroundWindow(); $fp = Get-Process | Where-Object { $_.MainWindowHandle -eq $front } | Select-Object -First 1; [void]$out.Add($(if ($fp) { $fp.ProcessName } else { '' }))
    }
    'windows' { [void]$out.Add(@(Windows)) }
    'frontmost' { $front = [Agent.Native]::GetForegroundWindow(); $p = Get-Process | Where-Object { $_.MainWindowHandle -eq $front } | Select-Object -First 1; [void]$out.Add($(if ($p) { $p.ProcessName } else { '' })) }
    default { throw "未知桌面动作：$($a.type)" }
  }
  Start-Sleep -Milliseconds 20
}
ConvertTo-Json -Compress -Depth 5 -InputObject @($out)
`;

async function runScript(actions: unknown[]) {
  const file = join(tmpdir(), `agent-desktop-${randomUUID()}.json`);
  try {
    await writeFile(file, JSON.stringify(actions), 'utf8');
    // 脚本含引号与多行，用 -EncodedCommand（UTF-16LE base64）传递，避免命令行转义问题。
    const {stdout} = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(winScript, 'utf16le').toString('base64')],
      {timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: {...process.env, AGENT_DESKTOP_ACTIONS: file}, windowsHide: true}).catch((error: Error & {stderr?: string}) => {
      throw new Error(`桌面操作失败：${(error.stderr || error.message).trim().slice(0, 500)}`);
    });
    const parsed = JSON.parse(stdout.trim() || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]) as unknown[];
  } finally {await rm(file, {force: true}).catch(() => undefined);}
}

export function createWindowsDriver(): PlatformDriver {
  return {
    platform: 'win32',
    run: actions => runScript(winActions(actions)),
    async capture() {
      const path = join(tmpdir(), `agent-desktop-${randomUUID()}.png`);
      try {await runScript([{type: 'capture', path}]); return await readFile(path);}
      catch (error) {throw new Error(`桌面截图失败：${error instanceof Error ? error.message.slice(0, 300) : '未知错误'}`);}
      finally {await rm(path, {force: true}).catch(() => undefined);}
    },
  };
}
