<#
  Focus watcher sidecar.

  Polls the Windows foreground window and emits NDJSON events on stdout.
  Accepts NDJSON commands on stdin.

  OUT  {"t":"focus","hwnd":..,"pid":..,"exe":"chrome.exe","path":"..","title":"..","url":"..","urlKnown":true}
  OUT  {"t":"ready"} | {"t":"error","message":".."}
  IN   {"cmd":"minimize","hwnd":123}
  IN   {"cmd":"foreground","hwnd":123}
  IN   {"cmd":"quit"}
#>

param(
  [int]$IntervalMs = 600
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class FocusWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr hWnd, EnumWindowsProc cb, IntPtr lp);
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  public static string Title(IntPtr h) {
    var sb = new StringBuilder(1024);
    GetWindowTextW(h, sb, 1024);
    return sb.ToString();
  }

  public static uint Pid(IntPtr h) {
    uint pid = 0;
    GetWindowThreadProcessId(h, out pid);
    return pid;
  }

  // UWP apps are hosted by ApplicationFrameHost.exe; the real app lives in a
  // child window owned by a different process. Dig it out.
  public static uint RealPid(IntPtr h) {
    uint host = Pid(h);
    uint found = 0;
    EnumChildWindows(h, delegate(IntPtr child, IntPtr lp) {
      uint cp = Pid(child);
      if (cp != 0 && cp != host) { found = cp; return false; }
      return true;
    }, IntPtr.Zero);
    return found != 0 ? found : host;
  }
}
"@

$SW_MINIMIZE = 6

# ---------------------------------------------------------------- URL reading
# UI Automation is the only way to read a browser's real URL without an
# extension. It can block on a busy app, so it runs in a disposable runspace
# with a hard timeout.

$script:UrlRunspace = $null
$script:UrlPipe = $null
$script:UrlHandle = $null
$script:UrlStartedAt = $null
$script:UrlForHwnd = 0

$UrlScript = {
  param($handle)
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$handle)
  if ($null -eq $el) { return '' }

  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Edit)

  $edits = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  $fallback = ''
  foreach ($e in $edits) {
    $value = ''
    try {
      $pattern = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $value = $pattern.Current.Value
    } catch { continue }
    if ([string]::IsNullOrWhiteSpace($value)) { continue }

    $name = ''
    try { $name = $e.Current.Name } catch {}
    # "Address and search bar" (Chrome/Edge), "Search with Google or enter address" (Firefox)
    if ($name -match 'address|search bar|enter address|url') { return $value }
    if ($fallback -eq '') { $fallback = $value }
  }
  return $fallback
}

function Reset-UrlRunspace {
  try { if ($script:UrlPipe) { $script:UrlPipe.Dispose() } } catch {}
  try { if ($script:UrlRunspace) { $script:UrlRunspace.Dispose() } } catch {}
  $script:UrlPipe = $null
  $script:UrlRunspace = $null
  $script:UrlHandle = $null
  $script:UrlStartedAt = $null
  $script:UrlForHwnd = 0
}

function Start-UrlRead([IntPtr]$hwnd) {
  Reset-UrlRunspace
  $script:UrlRunspace = [runspacefactory]::CreateRunspace()
  $script:UrlRunspace.ApartmentState = 'STA'
  $script:UrlRunspace.ThreadOptions = 'ReuseThread'
  $script:UrlRunspace.Open()
  $script:UrlPipe = [powershell]::Create()
  $script:UrlPipe.Runspace = $script:UrlRunspace
  [void]$script:UrlPipe.AddScript($UrlScript).AddArgument([int64]$hwnd)
  $script:UrlHandle = $script:UrlPipe.BeginInvoke()
  $script:UrlStartedAt = [DateTime]::UtcNow
  $script:UrlForHwnd = [int64]$hwnd
}

# Returns $null while still running, '' when it produced nothing.
function Complete-UrlRead([int]$timeoutMs) {
  if ($null -eq $script:UrlHandle) { return $null }

  if ($script:UrlHandle.IsCompleted) {
    $result = ''
    try {
      $out = $script:UrlPipe.EndInvoke($script:UrlHandle)
      if ($out -and $out.Count -gt 0) { $result = [string]$out[$out.Count - 1] }
    } catch { $result = '' }
    Reset-UrlRunspace
    return $result
  }

  if (([DateTime]::UtcNow - $script:UrlStartedAt).TotalMilliseconds -gt $timeoutMs) {
    try { $script:UrlPipe.Stop() } catch {}
    Reset-UrlRunspace
    return ''
  }
  return $null
}

# ------------------------------------------------------------------ emit/read
function Emit($obj) {
  try { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush() } catch {}
}

$BrowserExes = @('chrome.exe','msedge.exe','firefox.exe','brave.exe','opera.exe','opera_gx.exe','vivaldi.exe','arc.exe','librewolf.exe','zen.exe','thorium.exe','chromium.exe','waterfox.exe','floorp.exe')

$procCache = @{}
function Get-ProcInfo([uint32]$processId) {
  if ($procCache.ContainsKey($processId)) { return $procCache[$processId] }
  $info = @{ exe = ''; path = '' }
  try {
    $p = Get-Process -Id $processId -ErrorAction Stop
    $info.exe = "$($p.ProcessName).exe"
    try { if ($p.Path) { $info.path = $p.Path } } catch {}
  } catch {}
  if ($procCache.Count -gt 400) { $procCache.Clear() }
  $procCache[$processId] = $info
  return $info
}

# ----------------------------------------------------------------- main loop
Emit @{ t = 'ready' }

$stdin = [Console]::In
$pendingLine = $null
$running = $true

$lastKey = ''
$urlCacheKey = ''
$urlCacheValue = ''
$urlPendingKey = ''

while ($running) {

  # --- stdin commands (non-blocking) ---
  if ($null -eq $pendingLine) { $pendingLine = $stdin.ReadLineAsync() }
  while ($pendingLine -and $pendingLine.IsCompleted) {
    $line = $null
    try { $line = $pendingLine.Result } catch {}
    $pendingLine = $null
    if ($null -eq $line) { $running = $false; break }
    if ($line.Trim()) {
      try {
        $cmd = $line | ConvertFrom-Json
        switch ($cmd.cmd) {
          'minimize' {
            $h = [IntPtr][int64]$cmd.hwnd
            if ([FocusWin]::IsWindow($h)) { [void][FocusWin]::ShowWindow($h, $SW_MINIMIZE) }
          }
          'foreground' {
            $h = [IntPtr][int64]$cmd.hwnd
            if ([FocusWin]::IsWindow($h)) { [void][FocusWin]::SetForegroundWindow($h) }
          }
          'quit' { $running = $false }
        }
      } catch {}
    }
    if ($running -and $null -eq $pendingLine) { $pendingLine = $stdin.ReadLineAsync() }
  }
  if (-not $running) { break }

  # --- resolve a finished URL read ---
  $finished = Complete-UrlRead 2500
  if ($null -ne $finished -and $urlPendingKey) {
    $urlCacheKey = $urlPendingKey
    $urlCacheValue = $finished
    $urlPendingKey = ''
    $lastKey = ''   # force re-emit with the resolved URL
  }

  # --- poll foreground window ---
  try {
    $hwnd = [FocusWin]::GetForegroundWindow()
    if ($hwnd -ne [IntPtr]::Zero) {
      $processId = [FocusWin]::RealPid($hwnd)
      $title = [FocusWin]::Title($hwnd)
      $info = Get-ProcInfo $processId
      $exe = $info.exe

      $url = ''
      $urlKnown = $true
      if ($BrowserExes -contains $exe.ToLower()) {
        $key = "$([int64]$hwnd)|$title"
        if ($key -eq $urlCacheKey) {
          $url = $urlCacheValue
        } else {
          $urlKnown = $false
          if ($null -eq $script:UrlHandle) {
            $urlPendingKey = $key
            try { Start-UrlRead $hwnd } catch { $urlPendingKey = '' }
          }
        }
      }

      $key2 = "$([int64]$hwnd)|$title|$url|$urlKnown"
      if ($key2 -ne $lastKey) {
        $lastKey = $key2
        Emit @{
          t        = 'focus'
          hwnd     = [int64]$hwnd
          pid      = [int]$processId
          exe      = $exe
          path     = $info.path
          title    = $title
          url      = $url
          urlKnown = $urlKnown
        }
      }
    }
  } catch {
    Emit @{ t = 'error'; message = "$($_.Exception.Message)" }
  }

  Start-Sleep -Milliseconds $IntervalMs
}

Reset-UrlRunspace
