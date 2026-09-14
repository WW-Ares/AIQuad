#Requires -Version 5.1
<#
.SYNOPSIS
AIQuad 白条现场取证（自包含：不需要项目源码、不需要 node、不需要 npm）。

.DESCRIPTION
只在"复现状态"下跑：呼出 AIQuad 面板、分格里已经显示网页、能看到白条/列表框是白的。
脚本只读：不改窗口、不设区域、不杀进程。

产出（默认写到脚本同级的 diag-out-<时间戳>\，并自动打同名 zip）:
  00-env.txt        系统缩放 / 主题 / 高对比度 / 显卡 / 版本
  01-windows.txt    面板窗口与每个浏览器窗口：矩形、扩展样式、属主、全部子窗口
  02-region.txt     每个浏览器窗口的窗口区域：有没有、裁掉多少、关键点采样
  03-verdict.txt    自动判读：裁剪生没生效、顶栏被盖了多少像素
  shot-screen.png   整屏
  win-*.png         每个窗口的 PrintWindow（只画它自己，不含遮挡物）

用法:
  powershell -ExecutionPolicy Bypass -File .\diag-win.ps1
  powershell -ExecutionPolicy Bypass -File .\diag-win.ps1 -OutDir D:\diag
#>
param([string]$OutDir = '')

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------- 原生调用
$sig = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class N {
  public delegate bool EnumCb(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumCb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("gdi32.dll")]  public static extern IntPtr CreateRectRgn(int a, int b, int c, int d);
  [DllImport("user32.dll")] public static extern int  GetWindowRgn(IntPtr h, IntPtr r);
  [DllImport("gdi32.dll")]  public static extern int  GetRgnBox(IntPtr r, out RECT b);
  [DllImport("gdi32.dll")]  public static extern bool PtInRegion(IntPtr r, int x, int y);
  [DllImport("gdi32.dll")]  public static extern bool DeleteObject(IntPtr o);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern int  GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int  GetSystemDpiForProcess(IntPtr h);
  [DllImport("shcore.dll")] public static extern int  GetDpiForMonitor(IntPtr m, int t, out uint x, out uint y);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT p, uint f);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("dwmapi.dll")] public static extern int  DwmGetWindowAttribute(IntPtr h, uint a, out RECT r, int cb);
  [DllImport("dwmapi.dll")] public static extern int  DwmGetWindowAttribute(IntPtr h, uint a, out int v, int cb);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint b, out HIGHCONTRAST c, uint d);

  [StructLayout(LayoutKind.Sequential)]
  public struct HIGHCONTRAST { public uint cbSize; public uint dwFlags; public IntPtr lpszDefaultScheme; }
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X, Y; }

  public static void SetDpi() {
    // 必须最先做：否则 GetWindowRect 会被 DPI 虚拟化，量到的不是物理像素。
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch {}
  }

  static List<IntPtr> Collect(bool children, IntPtr parent) {
    var list = new List<IntPtr>();
    EnumCb cb = (h, l) => { list.Add(h); return true; };
    if (children) EnumChildWindows(parent, cb, IntPtr.Zero); else EnumWindows(cb, IntPtr.Zero);
    return list;
  }
  public static IntPtr[] TopWindows() { return Collect(false, IntPtr.Zero).ToArray(); }
  public static IntPtr[] ChildWindows(IntPtr p) { return Collect(true, p).ToArray(); }

  public static string Class(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static int[] Rect(IntPtr h) { RECT r; if (!GetWindowRect(h, out r)) return null; return new int[] { r.L, r.T, r.R, r.B }; }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static long Style(IntPtr h)   { try { return GetWindowLongPtr(h, -16).ToInt64(); } catch { return 0; } }
  public static long ExStyle(IntPtr h) { try { return GetWindowLongPtr(h, -20).ToInt64(); } catch { return 0; } }
  public static IntPtr Owner(IntPtr h) { return GetWindow(h, 4); }
  public static bool Visible(IntPtr h) { return IsWindowVisible(h); }

  public static int[] RegionBox(IntPtr h) {
    IntPtr r = CreateRectRgn(0, 0, 0, 0);
    if (r == IntPtr.Zero) return null;
    try {
      int t = GetWindowRgn(h, r);
      if (t <= 1) return null;
      RECT b; if (GetRgnBox(r, out b) == 0) return null;
      return new int[] { b.L, b.T, b.R, b.B };
    } finally { DeleteObject(r); }
  }
  public static bool PtIn(IntPtr h, int x, int y) {
    IntPtr r = CreateRectRgn(0, 0, 0, 0);
    if (r == IntPtr.Zero) return false;
    try {
      int t = GetWindowRgn(h, r);
      if (t <= 1) return true;
      return PtInRegion(r, x, y);
    } finally { DeleteObject(r); }
  }
  public static int DpiOf(IntPtr h) { try { return GetDpiForWindow(h); } catch { return 0; } }
  public static int SystemDpi() { try { return GetSystemDpiForProcess(IntPtr.Zero); } catch { return 0; } }
  public static int DpiAt(int x, int y) {
    try {
      POINT p = new POINT(); p.X = x; p.Y = y;
      IntPtr m = MonitorFromPoint(p, 2);
      if (m == IntPtr.Zero) m = MonitorFromWindow(IntPtr.Zero, 1);
      uint dx, dy;
      if (m != IntPtr.Zero && GetDpiForMonitor(m, 0, out dx, out dy) == 0) return (int)dx;
    } catch {}
    return 0;
  }
  public static bool Cloaked(IntPtr h) { int v; return DwmGetWindowAttribute(h, 14, out v, 4) == 0 && v != 0; }
  public static int[] FrameBounds(IntPtr h) { RECT r; if (DwmGetWindowAttribute(h, 9, out r, 16) != 0) return null; return new int[] { r.L, r.T, r.R, r.B }; }
  public static bool HiContrast() {
    HIGHCONTRAST hc = new HIGHCONTRAST(); hc.cbSize = (uint)Marshal.SizeOf(typeof(HIGHCONTRAST));
    if (!SystemParametersInfo(0x0042, 0, out hc, 0)) return false;
    return (hc.dwFlags & 0x00000001) != 0;
  }
}
'@
Add-Type -TypeDefinition $sig -Language CSharp -ErrorAction Stop
[N]::SetDpi()
Add-Type -AssemblyName System.Windows.Forms, System.Drawing -ErrorAction SilentlyContinue

if (-not $OutDir) { $OutDir = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) ("diag-out-" + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$OutDir = (Resolve-Path $OutDir).Path

function Say($s) { Write-Output $s }
function Fmt($r) { if (-not $r -or $r.Count -lt 4) { return '(无)' }; return "($($r[0]),$($r[1]))-($($r[2]),$($r[3]))  $($r[2]-$r[0])x$($r[3]-$r[1])" }
function Hex($v) { return '0x{0:x}' -f $v }
function Bits($v, $names) {
  $out = @()
  foreach ($k in $names.Keys) { if (($v -band $names[$k]) -ne 0) { $out += $k } }
  if ($out.Count -eq 0) { return '-' }; return ($out -join ',')
}
$EX = @{ TOOLWINDOW = 0x00000080; APPWINDOW = 0x00040000; LAYERED = 0x00080000; NOREDIR = 0x00200000; TOPMOST = 0x00000008; TRANSPARENT = 0x00000020 }
$ST = @{ VISIBLE = 0x10000000; POPUP = 0x80000000; CAPTION = 0x00C00000; THICK = 0x00040000; MINIMIZE = 0x20000000 }

Say '================ AIQuad 白条取证 ================'
Say ('时间: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Say ''

# ---------------------------------------------------------------- 1. 环境
$os = Get-CimInstance Win32_OperatingSystem
$bld = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
$th  = Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction SilentlyContinue
$envTxt = @()
$envTxt += "OS            : $($os.Caption)  build $($bld.CurrentBuild).$($bld.UBR)  (DisplayVersion $($bld.DisplayVersion))"
$envTxt += "高对比度       : $([N]::HiContrast())"
$envTxt += "主题           : AppsUseLightTheme=$(if ($th) { $th.AppsUseLightTheme } else { 'n/a' })  SystemUsesLightTheme=$(if ($th) { $th.SystemUsesLightTheme } else { 'n/a' })  EnableTransparency=$(if ($th) { $th.EnableTransparency } else { 'n/a' })"
$envTxt += "系统 DPI       : $([N]::SystemDpi()) (100%=96)"
foreach ($s in ([System.Windows.Forms.Screen]::AllScreens)) {
  $d = [N]::DpiAt($s.Bounds.X + [int]($s.Bounds.Width / 2), $s.Bounds.Y + [int]($s.Bounds.Height / 2))
  $envTxt += "显示器         : $($s.DeviceName) bounds=$($s.Bounds) primary=$($s.Primary) dpi=$d 缩放=$(if ($d) { [int](100 * $d / 96) } else { '?' })%"
}
foreach ($s in (Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue)) {
  $envTxt += "显卡           : $($s.Name)  驱动 $($s.DriverVersion)"
}

$appProcs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -eq 'AIQuad.exe' -or ($_.Name -eq 'electron.exe' -and $_.CommandLine -match 'aiquad')
})
if ($appProcs.Count) {
  foreach ($p in ($appProcs | Select-Object -First 3)) {
    $vi = $null; try { $vi = (Get-Item $p.ExecutablePath).VersionInfo } catch {}
    $envTxt += "AIQuad 进程    : pid=$($p.ProcessId)  $($p.ExecutablePath)  版本=$(if ($vi) { $vi.ProductVersion } else { '?' })"
  }
} else {
  $envTxt += "AIQuad 进程    : 没跑 —— 请先呼出面板再跑本脚本"
}
$envTxt | ForEach-Object { Say $_ }
$envTxt | Set-Content (Join-Path $OutDir '00-env.txt') -Encoding UTF8

if (-not $appProcs.Count) { Say '!! 没找到 AIQuad 进程，结束'; exit 1 }
$appPids = @($appProcs | ForEach-Object { $_.ProcessId })

# ---------------------------------------------------------------- 2. 窗口清单
Say ''
Say '---------------- 窗口清单 ----------------'
$top = @()
foreach ($h in [N]::TopWindows()) {
  $rect = [N]::Rect($h)
  if (-not $rect -or $rect.Count -lt 4) { continue }
  if (-not [N]::Visible($h)) { continue }
  if (($rect[2] - $rect[0]) -lt 60 -or ($rect[3] - $rect[1]) -lt 40) { continue }
  $procId = [N]::Pid($h)
  $top += [pscustomobject]@{
    Hwnd = [int64]$h; Pid = $procId; Class = [N]::Class($h); Title = [N]::Title($h)
    Rect = $rect; Owner = [int64][N]::Owner($h); Visible = [N]::Visible($h)
    Style = [N]::Style($h); ExStyle = [N]::ExStyle($h); Cloaked = [N]::Cloaked($h); Dpi = [N]::DpiOf($h)
  }
}

$panel = $top | Where-Object { $appPids -contains $_.Pid -and $_.Class -eq 'Chrome_WidgetWin_1' } |
  Sort-Object { -(($_.Rect[2] - $_.Rect[0]) * ($_.Rect[3] - $_.Rect[1])) } | Select-Object -First 1
if (-not $panel) { Say '!! 找不到面板窗口（面板是不是没呼出？）'; exit 1 }

$browsers = @($top | Where-Object { $_.Owner -eq $panel.Hwnd -and $_.Class -eq 'Chrome_WidgetWin_1' -and $_.Hwnd -ne $panel.Hwnd })
$browsers = @($browsers | Sort-Object { $_.Rect[1] }, { $_.Rect[0] })
Say "面板窗口: hwnd=$('0x{0:x}' -f $panel.Hwnd)  $(Fmt $panel.Rect)"
Say "挂在面板名下的浏览器窗口: $($browsers.Count) 个"
foreach ($b in $browsers) { Say ("  - hwnd=$('0x{0:x}' -f $b.Hwnd)  $(Fmt $b.Rect)  pid=$($b.Pid)") }
if (-not $browsers.Count) { Say '（没找到 —— 分格里的浏览器可能还没起来，等出页面再跑一次）' }

$winTxt = @()
$winTxt += "== [面板] hwnd=$('0x{0:x}' -f $panel.Hwnd) pid=$($panel.Pid) cls=$($panel.Class) title=$($panel.Title)"
$winTxt += "   rect    : $(Fmt $panel.Rect)  dpi=$($panel.Dpi)  cloaked=$($panel.Cloaked)"
$winTxt += "   style   : $(Hex $panel.Style) [$(Bits $panel.Style $ST)]"
$winTxt += "   exstyle : $(Hex $panel.ExStyle) [$(Bits $panel.ExStyle $EX)]"
$winTxt += "   DWM边框 : $(Fmt ([N]::FrameBounds([IntPtr]$panel.Hwnd)))  ← 与 rect 的差 = 系统画的边框/标题"
foreach ($c in ([N]::ChildWindows([IntPtr]$panel.Hwnd))) {
  $cr = [N]::Rect($c); if (-not $cr -or $cr.Count -lt 4) { continue }
  $winTxt += "   子窗口  : $([N]::Class($c))  $(Fmt $cr)  相对窗口 ($($cr[0]-$panel.Rect[0]),$($cr[1]-$panel.Rect[1]))  visible=$([N]::Visible($c))"
}
$winTxt += ''
foreach ($w in $browsers) {
  $winTxt += "== [浏览器] hwnd=$('0x{0:x}' -f $w.Hwnd) pid=$($w.Pid) owner=$('0x{0:x}' -f $w.Owner) title=$($w.Title)"
  $winTxt += "   rect    : $(Fmt $w.Rect)  dpi=$($w.Dpi)  cloaked=$($w.Cloaked)"
  $winTxt += "   style   : $(Hex $w.Style) [$(Bits $w.Style $ST)]"
  $winTxt += "   exstyle : $(Hex $w.ExStyle) [$(Bits $w.ExStyle $EX)]"
  $winTxt += "   DWM边框 : $(Fmt ([N]::FrameBounds([IntPtr]$w.Hwnd)))"
  $winTxt += "   exe     : $((Get-Process -Id $w.Pid -ErrorAction SilentlyContinue).Path)"
  foreach ($c in ([N]::ChildWindows([IntPtr]$w.Hwnd))) {
    $cr = [N]::Rect($c); if (-not $cr -or $cr.Count -lt 4) { continue }
    $winTxt += "   子窗口  : $([N]::Class($c))  $(Fmt $cr)  相对窗口 ($($cr[0]-$w.Rect[0]),$($cr[1]-$w.Rect[1]))  尺寸 $(($cr[2]-$cr[0]))x$(($cr[3]-$cr[1]))  visible=$([N]::Visible($c))"
  }
  $winTxt += ''
}
$winTxt | Set-Content (Join-Path $OutDir '01-windows.txt') -Encoding UTF8

# ---------------------------------------------------------------- 3. 区域
Say ''
Say '---------------- 窗口区域（裁剪有没有生效） ----------------'
$regTxt = @(); $verdict = @()
foreach ($w in $browsers) {
  $h = [IntPtr]$w.Hwnd
  $r = $w.Rect; $ww = $r[2] - $r[0]; $wh = $r[3] - $r[1]
  $box = [N]::RegionBox($h)
  $inset = $null
  foreach ($c in ([N]::ChildWindows($h))) {
    if ([N]::Class($c) -ne 'Chrome_RenderWidgetHostHWND') { continue }
    $cr = [N]::Rect($c); if (-not $cr -or $cr.Count -lt 4) { continue }
    $inset = [pscustomobject]@{ left = $cr[0] - $r[0]; top = $cr[1] - $r[1]; right = ($r[0] + $ww) - $cr[2]; bottom = ($r[1] + $wh) - $cr[3] }
    break
  }
  $regTxt += "== browser hwnd=$('0x{0:x}' -f $w.Hwnd)  窗口 $(Fmt $r)"
  $regTxt += "   实测内衬(网页内容区相对窗口): $(if ($inset) { "left=$($inset.left) top=$($inset.top) right=$($inset.right) bottom=$($inset.bottom)" } else { '找不到 Chrome_RenderWidgetHostHWND' })"
  if ($box) {
    $regTxt += "   窗口区域外接(窗口内坐标): l=$($box[0]) t=$($box[1]) r=$($box[2]) b=$($box[3])  尺寸 $($box[2]-$box[0])x$($box[3]-$box[1])"
    $regTxt += "   相对整窗: 上裁掉 $($box[1])px  左裁掉 $($box[0])px  下留 $($wh - $box[3])px  右留 $($ww - $box[2])px"
  } else {
    $regTxt += "   窗口区域: 无 → 浏览器整窗（含它自己的标题栏/边框）都画在面板上"
  }
  $topIn = if ($inset) { $inset.top } else { 87 }
  foreach ($s in @(
      @(2, 2, '窗口最左上角（浏览器自己的标题栏就在这）'),
      @(10, [Math]::Max(0, $topIn - 4), "内容区上边界再往上 4px（内容区上边界=$topIn）"),
      @(10, [Math]::Min($wh - 1, $topIn + 4), '内容区上边界再往下 4px'),
      @([int]($ww / 2), [Math]::Max(0, $wh - 20), '窗口底部中间（悬浮胶囊那一片）')
    )) {
    $regTxt += "   采样 ($($s[0]),$($s[1])) 在可见区内 = $([N]::PtIn($h, $s[0], $s[1]))   ← $($s[2])"
  }
  $regTxt += ''

  if (-not $box) {
    $verdict += "❌ hwnd=$('0x{0:x}' -f $w.Hwnd) 没有窗口区域：浏览器整窗都在画 → 顶栏/胶囊会被它自己的标题栏盖住"
  } elseif ($inset -and ($box[1] -lt ($inset.top - 2))) {
    $verdict += "⚠️ hwnd=$('0x{0:x}' -f $w.Hwnd) 区域顶边 $($box[1]) < 网页内容区上边界 $($inset.top)：浏览器自带的 $(($inset.top - $box[1]))px 没裁掉"
  } else {
    $verdict += "✅ hwnd=$('0x{0:x}' -f $w.Hwnd) 裁剪生效（区域顶边 $($box[1])）"
  }
}

$pd = $panel.Dpi; if ($pd -le 0) { $pd = [N]::SystemDpi() }
$ps = $pd / 96
$p = $panel.Rect
$headerBottom = $p[1] + [int](43 * $ps)
$verdict += "面板 $(Fmt $p)  dpi=$pd  顶栏占屏幕 y=$($p[1])..$headerBottom（按 43 DIP × $ps 估算）"
foreach ($w in $browsers) {
  $bx = [N]::RegionBox([IntPtr]$w.Hwnd)
  $bTop = if ($bx) { $bx[1] } else { 0 }
  $paintTop = $w.Rect[1] + $bTop
  $over = $headerBottom - $paintTop
  if ($over -gt 2) {
    $verdict += "❌ hwnd=$('0x{0:x}' -f $w.Hwnd) 从屏幕 y=$paintTop 开始画，比顶栏下沿($headerBottom)还高 $over px → 顶栏被盖住这么多（窗口上沿 $($w.Rect[1]) + 区域顶边 $(if ($bx) { $bx[1] } else { '无区域=0' })）"
  } else {
    $verdict += "✅ hwnd=$('0x{0:x}' -f $w.Hwnd) 从屏幕 y=$paintTop 开始画，在顶栏下沿($headerBottom)之下，没压住顶栏（窗口上沿 $($w.Rect[1]) + 区域顶边 $(if ($bx) { $bx[1] } else { '无区域=0' })）"
  }
}
$regTxt | ForEach-Object { Say $_ }
$regTxt | Set-Content (Join-Path $OutDir '02-region.txt') -Encoding UTF8

# ---------------------------------------------------------------- 4. 判读 + 截图
Say ''
Say '---------------- 判读 ----------------'
if (-not $verdict) { $verdict += '（没有浏览器窗口可判读）' }
$verdict | ForEach-Object { Say $_ }
$verdict | Set-Content (Join-Path $OutDir '03-verdict.txt') -Encoding UTF8

try {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
  $bmp.Save((Join-Path $OutDir 'shot-screen.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Say "整屏: shot-screen.png ($($vs.Width)x$($vs.Height))"
} catch { Say "整屏截图失败: $_" }

$targets = @($panel) + $browsers
foreach ($w in $targets) {
  $r = $w.Rect; $ww = $r[2] - $r[0]; $wh = $r[3] - $r[1]
  if ($ww -le 0 -or $wh -le 0 -or $ww -gt 4000 -or $wh -gt 4000) { continue }
  $kind = if ($w.Hwnd -eq $panel.Hwnd) { 'panel' } else { 'browser' }
  $name = "win-$kind-$('0x{0:x}' -f $w.Hwnd).png"
  try {
    $bmp = New-Object System.Drawing.Bitmap($ww, $wh)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    [void][N]::PrintWindow([IntPtr]$w.Hwnd, $hdc, 2)
    $g.ReleaseHdc($hdc)
    $bmp.Save((Join-Path $OutDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Say "PrintWindow(只画它自己): $name  $($ww)x$($wh)"
  } catch { Say "PrintWindow 失败 $name : $_" }
}

Say ''
Say "输出目录: $OutDir"
$zip = "$OutDir.zip"
try {
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path (Join-Path $OutDir '*') -DestinationPath $zip -Force
  Say "已打包: $zip"
} catch { Say "打包失败（手动压缩目录也行）: $_" }
Say '把这个 zip 发回去。'
