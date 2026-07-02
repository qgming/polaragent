param(
  [Parameter(Mandatory = $true)]
  [string]$Action
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-JsonResult {
  param([object]$Value)
  $Value | ConvertTo-Json -Depth 50 -Compress
}

function Get-InputObject {
  $raw = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return [pscustomobject]@{}
  }
  return $raw | ConvertFrom-Json
}

# 延迟配置（毫秒），可通过 JSON 参数覆盖
$script:Delays = [ordered]@{
  ActivateShowWindow = 80
  ActivateForeground = 120
  ClickBefore = 60
  ClickBetween = 30
  ClickAfter = 80
  TypeClipboard = 50
  TypePaste = 80
  DragBefore = 60
  DragBetween = 30
  ScrollBefore = 40
}

# 应用 delayMode / delays 覆盖，更新全局延迟配置
function Initialize-Delays {
  param([object]$InputObject)
  if ($null -eq $InputObject) { return }
  $delayMode = ("" + (Get-Prop $InputObject "delayMode" "")).Trim().ToLowerInvariant()
  $factor = switch ($delayMode) {
    "fast" { 0.5 }
    "slow" { 2.0 }
    default { 1.0 }
  }

  $overrides = Get-Prop $InputObject "delays" $null
  $keys = @($script:Delays.Keys)
  foreach ($key in $keys) {
    $base = [int]$script:Delays[$key]
    if ($null -ne $overrides -and $null -ne ($overrides.PSObject.Properties[$key])) {
      $base = [int]($overrides.PSObject.Properties[$key].Value)
    }
    $script:Delays[$key] = [int]([Math]::Round($base * $factor))
  }
}

function Get-Prop {
  param([object]$Object, [string]$Name, [object]$Default = $null)
  if ($null -eq $Object) { return $Default }
  $prop = $Object.PSObject.Properties[$Name]
  if ($null -eq $prop) { return $Default }
  if ($null -eq $prop.Value) { return $Default }
  return $prop.Value
}

function Get-ViewMode {
  param([object]$InputObject, [string]$Default = "control")
  $mode = ("" + (Get-Prop $InputObject "viewMode" $Default)).Trim().ToLowerInvariant()
  switch ($mode) {
    "raw" { return "raw" }
    "control" { return "control" }
    "content" { return "content" }
    default { throw "viewMode must be one of: raw, control, content." }
  }
}

function Get-DetailLevel {
  param([object]$InputObject, [string]$Default = "compact")
  $level = ("" + (Get-Prop $InputObject "detailLevel" $Default)).Trim().ToLowerInvariant()
  switch ($level) {
    "compact" { return "compact" }
    "full" { return "full" }
    default { throw "detailLevel must be one of: compact, full." }
  }
}

function Get-ViewCondition {
  param([string]$ViewMode = "control", [bool]$IncludeOffscreen = $false)
  $condition = switch ($ViewMode) {
    "raw" { [System.Windows.Automation.Automation]::RawViewCondition }
    "content" { [System.Windows.Automation.Automation]::ContentViewCondition }
    default { [System.Windows.Automation.Automation]::ControlViewCondition }
  }
  if ($null -eq $condition) {
    $condition = [System.Windows.Automation.Condition]::TrueCondition
  }
  if (-not $IncludeOffscreen) {
    $visible = New-Object System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::IsOffscreenProperty), $false
    $condition = New-Object System.Windows.Automation.AndCondition -ArgumentList $condition, $visible
  }
  return $condition
}

function Load-Assemblies {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName WindowsBase
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  if (-not ("WindowsComputerUseNative" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class WindowsComputerUseNative {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);

  [DllImport("user32.dll")]
  public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, [MarshalAs(UnmanagedType.LPArray)] INPUT[] pInputs, int cbSize);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  public const int MOUSEEVENTF_MOVE = 0x0001;
  public const int MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const int MOUSEEVENTF_LEFTUP = 0x0004;
  public const int MOUSEEVENTF_RIGHTDOWN = 0x0008;
  public const int MOUSEEVENTF_RIGHTUP = 0x0010;
  public const int MOUSEEVENTF_MIDDLEDOWN = 0x0020;
  public const int MOUSEEVENTF_MIDDLEUP = 0x0040;
  public const int MOUSEEVENTF_WHEEL = 0x0800;
  public const int MOUSEEVENTF_HWHEEL = 0x01000;

  public const ushort KEYEVENTF_EXTENDEDKEY = 0x0001;
  public const ushort KEYEVENTF_KEYUP = 0x0002;
  public const ushort KEYEVENTF_SCANCODE = 0x0008;

  // 虚拟键码常量
  public const ushort VK_SHIFT = 0x10;
  public const ushort VK_CONTROL = 0x11;
  public const ushort VK_MENU = 0x12;
  public const ushort VK_LWIN = 0x5B;
}

[StructLayout(LayoutKind.Explicit)]
public struct INPUT {
  [FieldOffset(0)] public uint type;
  [FieldOffset(8)] public KEYBDINPUT ki;
  [FieldOffset(8)] public MOUSEINPUT mi;
  [FieldOffset(8)] public HARDWAREINPUT hi;
}

[StructLayout(LayoutKind.Sequential)]
public struct KEYBDINPUT {
  public ushort wVk;
  public ushort wScan;
  public uint dwFlags;
  public uint time;
  public IntPtr dwExtraInfo;
}

[StructLayout(LayoutKind.Sequential)]
public struct MOUSEINPUT {
  public int dx;
  public int dy;
  public uint mouseData;
  public uint dwFlags;
  public uint time;
  public IntPtr dwExtraInfo;
}

[StructLayout(LayoutKind.Sequential)]
public struct HARDWAREINPUT {
  public uint uMsg;
  public ushort wParamL;
  public ushort wParamH;
}

public struct RECT {
  public int Left;
  public int Top;
  public int Right;
  public int Bottom;
}
"@
  }
}

function Invoke-Safe {
  param([scriptblock]$Block, [object]$Default = $null)
  try {
    return & $Block
  } catch {
    return $Default
  }
}

function Get-ControlTypeName {
  param([object]$ControlType)
  if ($null -eq $ControlType) { return $null }
  $name = Invoke-Safe { $ControlType.ProgrammaticName } $null
  if ($null -eq $name) { return $null }
  return ($name -replace "^ControlType\.", "")
}

function Convert-Rect {
  param([object]$Rect)
  if ($null -eq $Rect) { return $null }
  $empty = Invoke-Safe { $Rect.IsEmpty } $true
  if ($empty) { return $null }
  $x = [int][Math]::Round($Rect.X)
  $y = [int][Math]::Round($Rect.Y)
  $width = [int][Math]::Round($Rect.Width)
  $height = [int][Math]::Round($Rect.Height)
  return [ordered]@{
    x = $x
    y = $y
    width = $width
    height = $height
    centerX = [int]($x + ($width / 2))
    centerY = [int]($y + ($height / 2))
  }
}

function Get-Patterns {
  param([System.Windows.Automation.AutomationElement]$Element)
  $items = New-Object System.Collections.Generic.List[string]
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern) } $false) { $items.Add("Invoke") }
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) } $false) { $items.Add("Value") }
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern) } $false) { $items.Add("Toggle") }
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern) } $false) { $items.Add("SelectionItem") }
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern) } $false) { $items.Add("ExpandCollapse") }
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$pattern) } $false) { $items.Add("ScrollItem") }
  return ,([string[]]$items.ToArray())
}

function Get-ValueText {
  param([System.Windows.Automation.AutomationElement]$Element)
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) } $false) {
    return Invoke-Safe { $pattern.Current.Value } $null
  }
  return $null
}

# 优先读取 Cached 属性，若为空或异常则回退到 Current 属性
function Get-CachedOrCurrent {
  param([scriptblock]$CachedBlock, [scriptblock]$CurrentBlock)
  $cached = Invoke-Safe $CachedBlock $null
  if ($null -ne $cached) { return $cached }
  return Invoke-Safe $CurrentBlock $null
}

function Convert-ElementInfo {
  param(
    [System.Windows.Automation.AutomationElement]$Element,
    [string]$Id = $null,
    [int]$Depth = 0,
    [string]$DetailLevel = "full"
  )

  # 优先读取缓存属性，回退到 Current.*
  $name = Get-CachedOrCurrent { $Element.Cached.Name } { $Element.Current.Name }
  if ($null -eq $name) { $name = "" }
  $automationId = Get-CachedOrCurrent { $Element.Cached.AutomationId } { $Element.Current.AutomationId }
  if ($null -eq $automationId) { $automationId = "" }
  $className = Get-CachedOrCurrent { $Element.Cached.ClassName } { $Element.Current.ClassName }
  if ($null -eq $className) { $className = "" }
  $localizedControlType = Get-CachedOrCurrent { $Element.Cached.LocalizedControlType } { $Element.Current.LocalizedControlType }
  if ($null -eq $localizedControlType) { $localizedControlType = "" }

  $rect = Convert-Rect (Get-CachedOrCurrent { $Element.Cached.BoundingRectangle } { $Element.Current.BoundingRectangle })
  $processId = Get-CachedOrCurrent { $Element.Cached.ProcessId } { $Element.Current.ProcessId }
  $nativeHwnd = Get-CachedOrCurrent { $Element.Cached.NativeWindowHandle } { $Element.Current.NativeWindowHandle }
  $info = [ordered]@{
    id = $Id
    depth = $Depth
    name = $name
    automationId = $automationId
    className = $className
    controlType = Get-ControlTypeName (Get-CachedOrCurrent { $Element.Cached.ControlType } { $Element.Current.ControlType })
    boundingBox = $rect
    isEnabled = Get-CachedOrCurrent { $Element.Cached.IsEnabled } { $Element.Current.IsEnabled }
    isOffscreen = Get-CachedOrCurrent { $Element.Cached.IsOffscreen } { $Element.Current.IsOffscreen }
    hasKeyboardFocus = Get-CachedOrCurrent { $Element.Cached.HasKeyboardFocus } { $Element.Current.HasKeyboardFocus }
  }
  if ($DetailLevel -eq "full") {
    $runtime = Invoke-Safe { [string]::Join(".", $Element.GetRuntimeId()) } $null
    $value = Get-ValueText $Element
    $patterns = [string[]](Get-Patterns $Element)
    $info["localizedControlType"] = $localizedControlType
    $info["processId"] = $processId
    $info["nativeWindowHandle"] = $nativeHwnd
    $info["runtimeId"] = $runtime
    $info["value"] = $value
    $info["patterns"] = $patterns
  } else {
    if ($Depth -le 1 -and $null -ne $processId) { $info["processId"] = $processId }
    if ($null -ne $nativeHwnd -and [int64]$nativeHwnd -ne 0) { $info["nativeWindowHandle"] = $nativeHwnd }
  }
  return $info
}

function Has-WindowTarget {
  param([object]$InputObject)
  if ($null -eq $InputObject) { return $false }
  $title = [string](Get-Prop $InputObject "windowTitle" "")
  $processId = Get-Prop $InputObject "processId" $null
  $hwnd = Get-Prop $InputObject "nativeWindowHandle" $null
  return (-not [string]::IsNullOrWhiteSpace($title)) -or ($null -ne $processId) -or ($null -ne $hwnd)
}

function Test-TargetMatch {
  param([object]$Info, [object]$InputObject)
  $title = [string](Get-Prop $InputObject "windowTitle" "")
  $processId = Get-Prop $InputObject "processId" $null
  $hwnd = Get-Prop $InputObject "nativeWindowHandle" $null

  if (-not [string]::IsNullOrWhiteSpace($title)) {
    $name = "" + $Info.name
    if ($name.IndexOf($title, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  }
  if ($null -ne $processId -and [int]$Info.processId -ne [int]$processId) { return $false }
  if ($null -ne $hwnd -and [int64]$Info.nativeWindowHandle -ne [int64]$hwnd) { return $false }
  return $true
}

function Set-WindowForeground {
  param([System.Windows.Automation.AutomationElement]$Element)
  $hwnd = Invoke-Safe { $Element.Current.NativeWindowHandle } 0
  if ($hwnd -and $hwnd -ne 0) {
    $ptr = [IntPtr]([int64]$hwnd)
    [WindowsComputerUseNative]::ShowWindow($ptr, 9) | Out-Null
    Start-Sleep -Milliseconds $script:Delays.ActivateShowWindow
    [WindowsComputerUseNative]::SetForegroundWindow($ptr) | Out-Null
    Start-Sleep -Milliseconds $script:Delays.ActivateForeground
  }
}

function Activate-TargetIfRequested {
  param([object]$InputObject)
  if ((Has-WindowTarget $InputObject) -and [bool](Get-Prop $InputObject "activate" $false)) {
    $target = Resolve-TargetWindow $InputObject
    Set-WindowForeground $target
  }
}

function Resolve-TargetWindow {
  param([object]$InputObject)
  if (-not (Has-WindowTarget $InputObject)) { return $null }

  $hwnd = Get-Prop $InputObject "nativeWindowHandle" $null
  if ($null -ne $hwnd) {
    $element = Invoke-Safe { [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([int64]$hwnd)) } $null
    if ($null -eq $element) { throw "No UI Automation window found for nativeWindowHandle '$hwnd'." }
    return $element
  }

  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $children = Get-Children -Element $root -ViewMode "control" -IncludeOffscreen $true
  $fallback = $null
  for ($i = 0; $i -lt $children.Count; $i++) {
    $el = $children.Item($i)
    $info = Convert-ElementInfo -Element $el -Id "uia:root.$i" -Depth 1
    if (Test-TargetMatch -Info $info -InputObject $InputObject) {
      if (-not $info.isOffscreen) { return $el }
      if ($null -eq $fallback) { $fallback = $el }
    }
  }
  if ($null -ne $fallback) { return $fallback }
  throw "No top-level window matched the requested target."
}

function Get-ScopeRoot {
  param([string]$Scope, [object]$InputObject = $null)
  if ($Scope -eq "desktop") {
    return [System.Windows.Automation.AutomationElement]::RootElement
  }

  $target = Resolve-TargetWindow $InputObject
  if ($null -ne $target) {
    if ([bool](Get-Prop $InputObject "activate" $false)) {
      Set-WindowForeground $target
    }
    return $target
  }

  $hwnd = [WindowsComputerUseNative]::GetForegroundWindow()
  if ($hwnd -ne [IntPtr]::Zero) {
    $element = Invoke-Safe { [System.Windows.Automation.AutomationElement]::FromHandle($hwnd) } $null
    if ($null -ne $element) { return $element }
  }
  return [System.Windows.Automation.AutomationElement]::RootElement
}

# 创建 UIA CacheRequest，缓存常用属性以减少跨进程调用
function New-ElementCacheRequest {
  $cacheRequest = New-Object System.Windows.Automation.CacheRequest
  $cacheRequest.Add([System.Windows.Automation.AutomationElement]::NameProperty)
  $cacheRequest.Add([System.Windows.Automation.AutomationElement]::AutomationIdProperty)
  $cacheRequest.Add([System.Windows.Automation.AutomationElement]::ClassNameProperty)
  $cacheRequest.Add([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
  $cacheRequest.Add([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty)
  $cacheRequest.Add([System.Windows.Automation.AutomationElement]::IsEnabledProperty)
  $cacheRequest.Add([System.Windows.Automation.AutomationElement]::IsOffscreenProperty)
  $cacheRequest.Add([System.Windows.Automation.AutomationElement]::ProcessIdProperty)
  $cacheRequest.Add([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty)
  $cacheRequest.Add([System.Windows.Automation.AutomationElement]::HasKeyboardFocusProperty)
  $cacheRequest.Add([System.Windows.Automation.AutomationElement]::LocalizedControlTypeProperty)
  $cacheRequest.TreeScope = [System.Windows.Automation.TreeScope]::Element
  return $cacheRequest
}

function Get-Children {
  param(
    [System.Windows.Automation.AutomationElement]$Element,
    [string]$ViewMode = "control",
    [bool]$IncludeOffscreen = $false
  )
  $items = New-Object "System.Collections.Generic.List[System.Windows.Automation.AutomationElement]"
  try {
    $condition = Get-ViewCondition -ViewMode $ViewMode -IncludeOffscreen $IncludeOffscreen
    $collection = $Element.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
  } catch {
    return ,$items
  }
  if ($null -eq $collection) { return ,$items }
  for ($i = 0; $i -lt $collection.Count; $i++) {
    $items.Add($collection.Item($i))
  }
  return ,$items
}

function Convert-Tree {
  param(
    [System.Windows.Automation.AutomationElement]$Element,
    [string]$Path,
    [int]$Depth,
    [int]$MaxDepth,
    [ref]$Count,
    [int]$MaxNodes,
    [string]$ViewMode = "control",
    [bool]$IncludeOffscreen = $false,
    [string]$DetailLevel = "compact"
  )

  if ($Count.Value -ge $MaxNodes) { return $null }
  $id = "uia:$Path"
  $info = Convert-ElementInfo -Element $Element -Id $id -Depth $Depth -DetailLevel $DetailLevel
  $Count.Value = $Count.Value + 1
  $childrenOut = New-Object System.Collections.Generic.List[object]

  if ($Depth -lt $MaxDepth) {
    # 在遍历子元素时激活 CacheRequest，以批量缓存属性
    $cacheRequest = New-ElementCacheRequest
    $scope = $cacheRequest.Activate()
    try {
      $children = Get-Children -Element $Element -ViewMode $ViewMode -IncludeOffscreen $IncludeOffscreen
      if ($null -ne $children) {
        for ($i = 0; $i -lt $children.Count; $i++) {
          if ($Count.Value -ge $MaxNodes) { break }
          $childPath = "$Path.$i"
          $child = Convert-Tree -Element $children.Item($i) -Path $childPath -Depth ($Depth + 1) -MaxDepth $MaxDepth -Count $Count -MaxNodes $MaxNodes -ViewMode $ViewMode -IncludeOffscreen $IncludeOffscreen -DetailLevel $DetailLevel
          if ($null -ne $child) { $childrenOut.Add($child) }
        }
      }
    } finally {
      $scope.Dispose()
    }
  }
  $info["children"] = @($childrenOut.ToArray())
  return $info
}

function Resolve-Element {
  param([string]$ElementId, [object]$InputObject = $null)
  if ([string]::IsNullOrWhiteSpace($ElementId)) {
    throw "elementId is required."
  }
  if ($ElementId -notmatch "^uia:(active|root)(\.\d+)*$") {
    throw "Unsupported element id '$ElementId'. Use an id from windows_computer_use_snapshot or windows_computer_use_accessibility_tree."
  }

  $path = $ElementId.Substring(4)
  $parts = $path.Split(".")
  $scopeName = $parts[0]
  $viewMode = Get-ViewMode $InputObject "control"
  $includeOffscreen = [bool](Get-Prop $InputObject "includeOffscreen" $false)
  $element = if ($scopeName -eq "root") {
    [System.Windows.Automation.AutomationElement]::RootElement
  } else {
    Get-ScopeRoot "active_window" $InputObject
  }

  for ($i = 1; $i -lt $parts.Length; $i++) {
    $index = [int]$parts[$i]
    $children = Get-Children -Element $element -ViewMode $viewMode -IncludeOffscreen $includeOffscreen
    if ($null -eq $children -or $index -lt 0 -or $index -ge $children.Count) {
      throw "Element path '$ElementId' is stale or out of range at segment $i."
    }
    $element = $children.Item($index)
  }
  return $element
}

function Get-PointFromArgs {
  param([object]$InputObject)
  $elementId = Get-Prop $InputObject "elementId" $null
  if ($null -ne $elementId) {
    $el = Resolve-Element $elementId $InputObject
    $rect = Convert-Rect (Invoke-Safe { $el.Current.BoundingRectangle } $null)
    if ($null -eq $rect) { throw "Element '$elementId' has no clickable bounding box." }
    return [ordered]@{ x = $rect.centerX; y = $rect.centerY; element = $el; elementId = $elementId }
  }

  $x = Get-Prop $InputObject "x" $null
  $y = Get-Prop $InputObject "y" $null
  if ($null -eq $x -or $null -eq $y) {
    throw "Provide either elementId or x and y."
  }
  return [ordered]@{ x = [int]$x; y = [int]$y; element = $null; elementId = $null }
}

function Get-ButtonFlags {
  param([string]$Button)
  switch ($Button) {
    "right" { return @(0x0008, 0x0010) }
    "middle" { return @(0x0020, 0x0040) }
    default { return @(0x0002, 0x0004) }
  }
}

function Click-At {
  param([int]$X, [int]$Y, [string]$Button = "left", [int]$Count = 1)
  $flags = Get-ButtonFlags $Button
  [WindowsComputerUseNative]::SetCursorPos($X, $Y) | Out-Null
  Start-Sleep -Milliseconds $script:Delays.ClickBefore
  for ($i = 0; $i -lt $Count; $i++) {
    [WindowsComputerUseNative]::mouse_event($flags[0], 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds $script:Delays.ClickBetween
    [WindowsComputerUseNative]::mouse_event($flags[1], 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds $script:Delays.ClickAfter
  }
}

function Move-ToPoint {
  param([int]$X, [int]$Y)
  [WindowsComputerUseNative]::SetCursorPos($X, $Y) | Out-Null
}

function Capture-Screenshot {
  param(
    [string]$Target = "screen",
    [IntPtr]$WindowHandle = [IntPtr]::Zero,
    [int]$RegionX = 0,
    [int]$RegionY = 0,
    [int]$RegionWidth = 0,
    [int]$RegionHeight = 0,
    [string]$Format = "png",
    [int]$Quality = 90
  )

  # 根据目标模式确定截图区域
  $bounds = $null
  if ($Target -eq "window") {
    if ($WindowHandle -eq [IntPtr]::Zero) {
      $WindowHandle = [WindowsComputerUseNative]::GetForegroundWindow()
    }
    $rect = New-Object RECT
    if (-not [WindowsComputerUseNative]::GetWindowRect($WindowHandle, [ref]$rect)) {
      throw "GetWindowRect failed for window handle '$WindowHandle'."
    }
    $bounds = [ordered]@{
      Left = $rect.Left
      Top = $rect.Top
      Width = $rect.Right - $rect.Left
      Height = $rect.Bottom - $rect.Top
    }
  } elseif ($Target -eq "region") {
    if ($RegionWidth -le 0 -or $RegionHeight -le 0) {
      throw "region 截图的宽度和高度必须大于 0"
    }
    if ($RegionX -lt 0 -or $RegionY -lt 0) {
      throw "region 截图的坐标不能为负值"
    }
    $bounds = [ordered]@{
      Left = $RegionX
      Top = $RegionY
      Width = $RegionWidth
      Height = $RegionHeight
    }
  } else {
    $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bounds = [ordered]@{
      Left = $screen.Left
      Top = $screen.Top
      Width = $screen.Width
      Height = $screen.Height
    }
  }

  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)

    $formatLower = $Format.ToLowerInvariant()
    $mimeType = if ($formatLower -eq "jpeg" -or $formatLower -eq "jpg") { "image/jpeg" } else { "image/png" }
    $ext = if ($formatLower -eq "jpeg" -or $formatLower -eq "jpg") { "jpg" } else { "png" }
    $file = Join-Path $env:TEMP ("windows-computer-use-" + [Guid]::NewGuid().ToString("N") + ".$ext")

    if ($formatLower -eq "jpeg" -or $formatLower -eq "jpg") {
      # JPEG 质量参数
      $quality = [Math]::Max(1, [Math]::Min(100, $Quality))
      $encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
      $encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
      $encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
      $bitmap.Save($file, $encoder, $encoderParams)
    } else {
      $bitmap.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    }

    $bytes = [System.IO.File]::ReadAllBytes($file)
    return [ordered]@{
      path = $file
      mimeType = $mimeType
      base64 = [Convert]::ToBase64String($bytes)
      bounds = [ordered]@{
        x = $bounds.Left
        y = $bounds.Top
        width = $bounds.Width
        height = $bounds.Height
      }
    }
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Get-TreeResult {
  param([string]$Scope, [int]$MaxDepth, [int]$MaxNodes, [object]$InputObject = $null)
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $viewMode = Get-ViewMode $InputObject "control"
  $includeOffscreen = [bool](Get-Prop $InputObject "includeOffscreen" $false)
  $detailLevel = Get-DetailLevel $InputObject "compact"
  $root = Get-ScopeRoot $Scope $InputObject
  $prefix = if ($Scope -eq "desktop") { "root" } else { "active" }
  $count = 0
  $tree = Convert-Tree -Element $root -Path $prefix -Depth 0 -MaxDepth $MaxDepth -Count ([ref]$count) -MaxNodes $MaxNodes -ViewMode $viewMode -IncludeOffscreen $includeOffscreen -DetailLevel $detailLevel
  $stopwatch.Stop()
  return [ordered]@{
    ok = $true
    scope = $Scope
    viewMode = $viewMode
    includeOffscreen = $includeOffscreen
    detailLevel = $detailLevel
    nodeCount = $count
    truncated = ($count -ge $MaxNodes)
    durationMs = [int]$stopwatch.ElapsedMilliseconds
    tree = $tree
  }
}

function Element-Matches {
  param([object]$Info, [string]$Query, [string]$ControlType)
  if (-not [string]::IsNullOrWhiteSpace($ControlType)) {
    if (($Info.controlType + "") -notlike "*$ControlType*") { return $false }
  }
  if ([string]::IsNullOrWhiteSpace($Query)) { return $true }
  $haystack = @(
    $Info.name,
    $Info.automationId,
    $Info.className,
    $Info.controlType,
    $Info.localizedControlType,
    $Info.value
  ) -join "`n"
  return $haystack.IndexOf($Query, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Search-Tree {
  param([object]$Node, [string]$Query, [string]$ControlType, [int]$MaxResults, [System.Collections.Generic.List[object]]$Results)
  if ($null -eq $Node -or $Results.Count -ge $MaxResults) { return }
  if (Element-Matches -Info $Node -Query $Query -ControlType $ControlType) {
    $copy = [ordered]@{}
    foreach ($prop in $Node.Keys) {
      if ($prop -ne "children") { $copy[$prop] = $Node[$prop] }
    }
    $Results.Add($copy)
  }
  foreach ($child in @($Node.children)) {
    if ($Results.Count -ge $MaxResults) { break }
    Search-Tree -Node $child -Query $Query -ControlType $ControlType -MaxResults $MaxResults -Results $Results
  }
}

# 按键名称到虚拟键码（VK_CODE）的映射表
function Convert-KeyArray {
  param([object[]]$Keys)
  $vkMap = @{
    "ctrl" = 0x11; "control" = 0x11;
    "alt" = 0x12; "option" = 0x12;
    "shift" = 0x10;
    "cmd" = 0x5B; "meta" = 0x5B; "win" = 0x5B; "windows" = 0x5B;
    "enter" = 0x0D; "return" = 0x0D;
    "tab" = 0x09; "esc" = 0x1B; "escape" = 0x1B;
    "backspace" = 0x08; "delete" = 0x2E; "del" = 0x2E;
    "insert" = 0x2D; "space" = 0x20;
    "home" = 0x24; "end" = 0x23;
    "pageup" = 0x21; "pagedown" = 0x22;
    "up" = 0x26; "down" = 0x28; "left" = 0x25; "right" = 0x27
  }
  for ($i = 1; $i -le 12; $i++) { $vkMap["f$i"] = 0x70 + $i - 1 }

  $result = New-Object System.Collections.Generic.List[uint16]
  foreach ($keyRaw in $Keys) {
    $key = ("" + $keyRaw).Trim()
    $lower = $key.ToLowerInvariant()
    if ($vkMap.ContainsKey($lower)) {
      $result.Add([uint16]$vkMap[$lower])
    } elseif ($key.Length -eq 1 -and [char]::IsLetter($key[0])) {
      # A-Z
      $result.Add([uint16](0x41 + [int][char]::ToUpperInvariant($key[0]) - 65))
    } elseif ($key.Length -eq 1 -and [char]::IsDigit($key[0])) {
      # 0-9
      $result.Add([uint16](0x30 + [int][string]$key[0]))
    } else {
      throw "Unsupported key '$key'."
    }
  }
  return ,([uint16[]]$result.ToArray())
}

# 使用 SendInput API 发送按键序列，支持 Windows 键与修饰键组合
function Send-KeyInput {
  param([object[]]$Keys)
  $vkCodes = Convert-KeyArray -Keys $Keys
  $modifiers = New-Object System.Collections.Generic.List[uint16]
  $mainKeys = New-Object System.Collections.Generic.List[uint16]
  $modSet = @(0x10, 0x11, 0x12, 0x5B)
  foreach ($vk in $vkCodes) {
    if ($modSet -contains $vk) {
      $modifiers.Add($vk)
    } else {
      $mainKeys.Add($vk)
    }
  }
  if ($mainKeys.Count -eq 0) { throw "A non-modifier key is required." }

  $inputs = New-Object System.Collections.Generic.List[INPUT]

  # 按下所有修饰键
  foreach ($vk in $modifiers) {
    $in = New-Object INPUT
    $in.type = 1
    $in.ki.wVk = $vk
    $inputs.Add($in)
  }

  foreach ($main in $mainKeys) {
    # 按下主键
    $down = New-Object INPUT
    $down.type = 1
    $down.ki.wVk = $main
    $inputs.Add($down)
    # 释放主键
    $up = New-Object INPUT
    $up.type = 1
    $up.ki.wVk = $main
    $up.ki.dwFlags = [WindowsComputerUseNative]::KEYEVENTF_KEYUP
    $inputs.Add($up)
  }

  # 释放所有修饰键（反向顺序）
  for ($i = $modifiers.Count - 1; $i -ge 0; $i--) {
    $in = New-Object INPUT
    $in.type = 1
    $in.ki.wVk = $modifiers[$i]
    $in.ki.dwFlags = [WindowsComputerUseNative]::KEYEVENTF_KEYUP
    $inputs.Add($in)
  }

  $arr = [INPUT[]]$inputs.ToArray()
  $sent = [WindowsComputerUseNative]::SendInput([uint32]$arr.Length, $arr, [System.Runtime.InteropServices.Marshal]::SizeOf([type][INPUT]))
  if ($sent -ne $arr.Length) {
    throw "SendInput failed (sent $sent of $($arr.Length))."
  }
}

function Type-Text {
  param([string]$Text, [bool]$RestoreClipboard = $true)
  $hadText = $false
  $oldText = $null
  try {
    $hadText = [System.Windows.Forms.Clipboard]::ContainsText()
    if ($hadText) { $oldText = [System.Windows.Forms.Clipboard]::GetText() }
  } catch {
    $hadText = $false
  }

  [System.Windows.Forms.Clipboard]::SetText($Text)
  Start-Sleep -Milliseconds $script:Delays.TypeClipboard
  [System.Windows.Forms.SendKeys]::SendWait("^v")
  Start-Sleep -Milliseconds $script:Delays.TypePaste

  if ($RestoreClipboard) {
    try {
      if ($hadText) {
        [System.Windows.Forms.Clipboard]::SetText($oldText)
      } else {
        [System.Windows.Forms.Clipboard]::Clear()
      }
    } catch {}
  }
}

function Invoke-ElementPattern {
  param([System.Windows.Automation.AutomationElement]$Element)
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern) } $false) {
    $pattern.Invoke()
    return "Invoke"
  }
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern) } $false) {
    $pattern.Toggle()
    return "Toggle"
  }
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern) } $false) {
    $pattern.Select()
    return "SelectionItem"
  }
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern) } $false) {
    $state = Invoke-Safe { $pattern.Current.ExpandCollapseState } $null
    if ($state -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed) {
      $pattern.Expand()
    } else {
      $pattern.Collapse()
    }
    return "ExpandCollapse"
  }
  return $null
}

function Set-ElementValue {
  param([System.Windows.Automation.AutomationElement]$Element, [string]$Value)
  $pattern = $null
  if (Invoke-Safe { $Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) } $false) {
    $pattern.SetValue($Value)
    return "ValuePattern"
  }
  return $null
}

function Invoke-ComputerUseAction {
  param([string]$ActionName, [object]$inputObject)

  # 根据传入参数初始化延迟配置
  Initialize-Delays -InputObject $inputObject

  switch ($ActionName) {
    "health" {
      $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $active = Get-ScopeRoot "active_window"
      Write-JsonResult ([ordered]@{
        ok = $true
        platform = "Windows"
        powershell = $PSVersionTable.PSVersion.ToString()
        uiAutomation = $true
        screenshot = $true
        activeWindow = Convert-ElementInfo -Element $active -Id "uia:active" -Depth 0
        virtualScreen = [ordered]@{ x = $screen.Left; y = $screen.Top; width = $screen.Width; height = $screen.Height }
      })
    }
    "snapshot" {
      $scope = Get-Prop $inputObject "scope" "active_window"
      $includeScreenshot = [bool](Get-Prop $inputObject "includeScreenshot" $true)
      $maxDepth = [int](Get-Prop $inputObject "maxDepth" 5)
      $maxNodes = [int](Get-Prop $inputObject "maxNodes" 250)
      $treeResult = Get-TreeResult -Scope $scope -MaxDepth $maxDepth -MaxNodes $maxNodes -InputObject $inputObject
      if ($includeScreenshot) {
        $screenshotTarget = [string](Get-Prop $inputObject "screenshotTarget" "screen")
        $screenshotFormat = [string](Get-Prop $inputObject "screenshotFormat" "png")
        $screenshotQuality = [int](Get-Prop $inputObject "screenshotQuality" 90)
        $hwnd = Get-Prop $inputObject "nativeWindowHandle" $null
        $windowHandle = if ($null -ne $hwnd) { [IntPtr]([int64]$hwnd) } else { [IntPtr]::Zero }
        $screenshotParams = @{
          Target = $screenshotTarget
          Format = $screenshotFormat
          Quality = $screenshotQuality
          WindowHandle = $windowHandle
          RegionX = [int](Get-Prop $inputObject "regionX" 0)
          RegionY = [int](Get-Prop $inputObject "regionY" 0)
          RegionWidth = [int](Get-Prop $inputObject "regionWidth" 0)
          RegionHeight = [int](Get-Prop $inputObject "regionHeight" 0)
        }
        $treeResult.screenshot = Capture-Screenshot @screenshotParams
      }
      Write-JsonResult $treeResult
    }
    "tree" {
      $scope = Get-Prop $inputObject "scope" "active_window"
      $maxDepth = [int](Get-Prop $inputObject "maxDepth" 6)
      $maxNodes = [int](Get-Prop $inputObject "maxNodes" 500)
      Write-JsonResult (Get-TreeResult -Scope $scope -MaxDepth $maxDepth -MaxNodes $maxNodes -InputObject $inputObject)
    }
    "list_windows" {
      $includeInvisible = [bool](Get-Prop $inputObject "includeInvisible" $false)
      $maxWindows = [int](Get-Prop $inputObject "maxWindows" 50)
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      $children = Get-Children -Element $root -ViewMode "control" -IncludeOffscreen $true
      $windows = New-Object System.Collections.Generic.List[object]
      for ($i = 0; $i -lt $children.Count; $i++) {
        if ($windows.Count -ge $maxWindows) { break }
        $el = $children.Item($i)
        $info = Convert-ElementInfo -Element $el -Id "uia:root.$i" -Depth 1
        if (-not $includeInvisible -and $info.isOffscreen) { continue }
        $windows.Add($info)
      }
      Write-JsonResult ([ordered]@{ ok = $true; windows = @($windows.ToArray()); count = $windows.Count })
    }
    "find" {
      $query = Get-Prop $inputObject "query" ""
      $scope = Get-Prop $inputObject "scope" "active_window"
      $controlType = Get-Prop $inputObject "controlType" ""
      $maxDepth = [int](Get-Prop $inputObject "maxDepth" 8)
      $maxNodes = [int](Get-Prop $inputObject "maxNodes" 1200)
      $maxResults = [int](Get-Prop $inputObject "maxResults" 25)
      $findInput = [pscustomobject]@{
        viewMode = Get-ViewMode $inputObject "control"
        includeOffscreen = [bool](Get-Prop $inputObject "includeOffscreen" $false)
        detailLevel = "full"
        windowTitle = Get-Prop $inputObject "windowTitle" $null
        processId = Get-Prop $inputObject "processId" $null
        nativeWindowHandle = Get-Prop $inputObject "nativeWindowHandle" $null
        activate = [bool](Get-Prop $inputObject "activate" $false)
      }
      $treeResult = Get-TreeResult -Scope $scope -MaxDepth $maxDepth -MaxNodes $maxNodes -InputObject $findInput
      $results = New-Object System.Collections.Generic.List[object]
      Search-Tree -Node $treeResult.tree -Query $query -ControlType $controlType -MaxResults $maxResults -Results $results
      Write-JsonResult ([ordered]@{ ok = $true; query = $query; results = @($results.ToArray()); count = $results.Count; scannedNodes = $treeResult.nodeCount; truncated = $treeResult.truncated })
    }
    "element_info" {
      $elementId = Get-Prop $inputObject "elementId" $null
      if ($null -ne $elementId) {
        $el = Resolve-Element $elementId $inputObject
        Write-JsonResult ([ordered]@{ ok = $true; element = (Convert-ElementInfo -Element $el -Id $elementId -Depth 0) })
      } else {
        $x = [int](Get-Prop $inputObject "x" 0)
        $y = [int](Get-Prop $inputObject "y" 0)
        $point = New-Object System.Windows.Point($x, $y)
        $el = [System.Windows.Automation.AutomationElement]::FromPoint($point)
        Write-JsonResult ([ordered]@{ ok = $true; point = [ordered]@{ x = $x; y = $y }; element = (Convert-ElementInfo -Element $el -Id $null -Depth 0) })
      }
    }
    "click" {
      $point = Get-PointFromArgs $inputObject
      $button = Get-Prop $inputObject "button" "left"
      Click-At -X $point.x -Y $point.y -Button $button -Count 1
      Write-JsonResult ([ordered]@{ ok = $true; action = "click"; x = $point.x; y = $point.y; button = $button; elementId = $point.elementId })
    }
    "double_click" {
      $point = Get-PointFromArgs $inputObject
      $button = Get-Prop $inputObject "button" "left"
      Click-At -X $point.x -Y $point.y -Button $button -Count 2
      Write-JsonResult ([ordered]@{ ok = $true; action = "double_click"; x = $point.x; y = $point.y; button = $button; elementId = $point.elementId })
    }
    "move" {
      $point = Get-PointFromArgs $inputObject
      Move-ToPoint -X $point.x -Y $point.y
      Write-JsonResult ([ordered]@{ ok = $true; action = "move"; x = $point.x; y = $point.y; elementId = $point.elementId })
    }
    "drag" {
      Activate-TargetIfRequested $inputObject
      $path = @(Get-Prop $inputObject "path" @())
      if ($path.Count -lt 2) { throw "path must contain at least two points." }
      $button = Get-Prop $inputObject "button" "left"
      $flags = Get-ButtonFlags $button
      [WindowsComputerUseNative]::SetCursorPos([int]$path[0].x, [int]$path[0].y) | Out-Null
      Start-Sleep -Milliseconds $script:Delays.DragBefore
      [WindowsComputerUseNative]::mouse_event($flags[0], 0, 0, 0, [UIntPtr]::Zero)
      foreach ($pt in $path) {
        [WindowsComputerUseNative]::SetCursorPos([int]$pt.x, [int]$pt.y) | Out-Null
        Start-Sleep -Milliseconds $script:Delays.DragBetween
      }
      [WindowsComputerUseNative]::mouse_event($flags[1], 0, 0, 0, [UIntPtr]::Zero)
      Write-JsonResult ([ordered]@{ ok = $true; action = "drag"; points = $path.Count; button = $button })
    }
    "scroll" {
      $elementId = Get-Prop $inputObject "elementId" $null
      $deltaY = [int](Get-Prop $inputObject "deltaY" 480)
      $deltaX = [int](Get-Prop $inputObject "deltaX" 0)

      # 如果提供了 elementId，优先尝试 UIA ScrollPattern
      if ($null -ne $elementId) {
        $el = Resolve-Element $elementId $inputObject
        $scrollPattern = Invoke-Safe { $el.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern) } $null
        if ($scrollPattern) {
          if ($deltaY -ne 0) {
            $scrollAmount = if ($deltaY -gt 0) { [System.Windows.Automation.ScrollAmount]::SmallIncrement } else { [System.Windows.Automation.ScrollAmount]::SmallDecrement }
            $repeatCount = [Math]::Min(50, [Math]::Max(1, [Math]::Abs($deltaY) / 120))
            for ($i = 0; $i -lt $repeatCount; $i++) {
              $scrollPattern.ScrollVertical($scrollAmount)
            }
          }
          if ($deltaX -ne 0) {
            $scrollAmount = if ($deltaX -gt 0) { [System.Windows.Automation.ScrollAmount]::SmallIncrement } else { [System.Windows.Automation.ScrollAmount]::SmallDecrement }
            $repeatCount = [Math]::Min(50, [Math]::Max(1, [Math]::Abs($deltaX) / 120))
            for ($i = 0; $i -lt $repeatCount; $i++) {
              $scrollPattern.ScrollHorizontal($scrollAmount)
            }
          }
          Write-JsonResult ([ordered]@{ ok = $true; action = "scroll"; deltaX = $deltaX; deltaY = $deltaY; elementId = $elementId; method = "ScrollPattern" })
          break
        }
        # ScrollPattern 不支持，回退到 mouse_event，并将鼠标移到元素中心
      }

      $point = Get-PointFromArgs $inputObject
      [WindowsComputerUseNative]::SetCursorPos($point.x, $point.y) | Out-Null
      Start-Sleep -Milliseconds $script:Delays.ScrollBefore
      if ($deltaY -ne 0) {
        [WindowsComputerUseNative]::mouse_event(0x0800, 0, 0, -1 * $deltaY, [UIntPtr]::Zero)
      }
      if ($deltaX -ne 0) {
        [WindowsComputerUseNative]::mouse_event(0x01000, 0, 0, $deltaX, [UIntPtr]::Zero)
      }
      Write-JsonResult ([ordered]@{ ok = $true; action = "scroll"; x = $point.x; y = $point.y; deltaX = $deltaX; deltaY = $deltaY; elementId = $point.elementId; method = "mouse_event" })
    }
    "type_text" {
      Activate-TargetIfRequested $inputObject
      $text = [string](Get-Prop $inputObject "text" "")
      $restore = [bool](Get-Prop $inputObject "restoreClipboard" $true)
      Type-Text -Text $text -RestoreClipboard $restore
      Write-JsonResult ([ordered]@{ ok = $true; action = "type_text"; length = $text.Length; restoreClipboard = $restore })
    }
    "keypress" {
      Activate-TargetIfRequested $inputObject
      $keys = @(Get-Prop $inputObject "keys" @())
      Send-KeyInput -Keys $keys
      Write-JsonResult ([ordered]@{ ok = $true; action = "keypress"; keys = $keys; method = "SendInput" })
    }
    "focus" {
      $elementId = [string](Get-Prop $inputObject "elementId" "")
      $el = Resolve-Element $elementId $inputObject
      $el.SetFocus()
      Write-JsonResult ([ordered]@{ ok = $true; action = "focus"; elementId = $elementId })
    }
    "invoke" {
      $elementId = [string](Get-Prop $inputObject "elementId" "")
      $fallback = [bool](Get-Prop $inputObject "fallbackClick" $true)
      $el = Resolve-Element $elementId $inputObject
      $method = Invoke-ElementPattern -Element $el
      if ($null -eq $method -and $fallback) {
        $rect = Convert-Rect (Invoke-Safe { $el.Current.BoundingRectangle } $null)
        if ($null -eq $rect) { throw "Element has no invokable pattern and no bounding box for fallback click." }
        Click-At -X $rect.centerX -Y $rect.centerY -Button "left" -Count 1
        $method = "ClickFallback"
      }
      if ($null -eq $method) { throw "Element has no supported invokable pattern." }
      Write-JsonResult ([ordered]@{ ok = $true; action = "invoke"; elementId = $elementId; method = $method })
    }
    "set_value" {
      $elementId = [string](Get-Prop $inputObject "elementId" "")
      $value = [string](Get-Prop $inputObject "value" "")
      $fallback = [bool](Get-Prop $inputObject "fallbackType" $true)
      $restore = [bool](Get-Prop $inputObject "restoreClipboard" $true)
      $el = Resolve-Element $elementId $inputObject
      $method = Set-ElementValue -Element $el -Value $value
      if ($null -eq $method -and $fallback) {
        $el.SetFocus()
        [System.Windows.Forms.SendKeys]::SendWait("^a")
        Type-Text -Text $value -RestoreClipboard $restore
        $method = "FocusSelectAllTypeFallback"
      }
      if ($null -eq $method) { throw "Element has no ValuePattern and fallbackType is false." }
      Write-JsonResult ([ordered]@{ ok = $true; action = "set_value"; elementId = $elementId; method = $method; length = $value.Length })
    }
    "activate_window" {
      if (-not (Has-WindowTarget $inputObject)) { throw "Provide windowTitle, processId, or nativeWindowHandle." }
      $el = Resolve-TargetWindow $inputObject
      Set-WindowForeground $el
      Write-JsonResult ([ordered]@{ ok = $true; action = "activate_window"; window = (Convert-ElementInfo -Element $el -Id "uia:active" -Depth 0) })
    }
    "wait" {
      $milliseconds = [int](Get-Prop $inputObject "milliseconds" 500)
      Start-Sleep -Milliseconds $milliseconds
      Write-JsonResult ([ordered]@{ ok = $true; action = "wait"; milliseconds = $milliseconds })
    }
    default {
      throw "Unknown action '$ActionName'."
    }
  }
}

try {
  Load-Assemblies

  if ($Action -eq "__worker") {
    while ($true) {
      $line = [Console]::In.ReadLine()
      if ($null -eq $line) { break }
      if ([string]::IsNullOrWhiteSpace($line)) { continue }

      $requestAction = ""
      try {
        $request = $line | ConvertFrom-Json
        $requestAction = [string](Get-Prop $request "action" "")
        $requestArgs = Get-Prop $request "args" ([pscustomobject]@{})
        Invoke-ComputerUseAction -ActionName $requestAction -inputObject $requestArgs
      } catch {
        Write-JsonResult ([ordered]@{
          ok = $false
          action = $requestAction
          error = $_.Exception.Message
          category = $_.CategoryInfo.Category.ToString()
          scriptStackTrace = $_.ScriptStackTrace
        })
      }
    }
    exit 0
  }

  $inputObject = Get-InputObject
  Invoke-ComputerUseAction -ActionName $Action -inputObject $inputObject
} catch {
  Write-JsonResult ([ordered]@{
    ok = $false
    action = $Action
    error = $_.Exception.Message
    category = $_.CategoryInfo.Category.ToString()
    scriptStackTrace = $_.ScriptStackTrace
  })
  exit 1
}
