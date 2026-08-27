# scripts/fix-ide-node.ps1
# 根治 Qoder IDE 扩展 node.exe 缺失（0xc0000142 弹窗根因之一）
# ──────────────────────────────────────────────────────────────
# 背景（2026-08-27 排查实证）：
# - IDE 日志反复出现 "extension node binary not found ... will download later"
# - 目标目录 C:\Program Files\Qoder CN IDE\...\bin\x86_64_windows 缺 node.exe，
#   且 Program Files 默认不可写 → IDE 每次尝试下载都失败 → 反复尝试启动
#   缺失的 node.exe → node.exe 0xc0000142 弹窗（"总是弹出"）
# - 本脚本给目标目录授权当前用户写权限 → IDE 重启后自动完成 node.exe 下载
#
# 用法（普通双击/终端运行即可——非管理员时自动弹 UAC 提权）：
#   powershell -ExecutionPolicy Bypass -File scripts/fix-ide-node.ps1
# 完成后：完全退出并重启 Qoder IDE
# ──────────────────────────────────────────────────────────────
$ErrorActionPreference = 'Continue'

# 非管理员时自动请求 UAC 提权重启（用户点击"是"后以管理员继续）
$isAdmin = (
    [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host '需要管理员权限——正在请求提升（请在弹出的 UAC 对话框点击"是"）...'
    Start-Process powershell -Verb RunAs -ArgumentList `
        "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

$dirs = @(
    'C:\Program Files\Qoder CN IDE\resources\app\resources\bin\x86_64_windows',
    'E:\QoderCN\resources\app\resources\bin\x86_64_windows'
)

$changed = $false
foreach ($dir in $dirs) {
    if (-not (Test-Path $dir)) { continue }
    $node = Join-Path $dir 'node.exe'
    Write-Host "== $dir"
    if (Test-Path $node) {
        $len = (Get-Item $node).Length
        Write-Host "  node.exe 已存在（$len B）——无需修复"
    } else {
        icacls $dir /grant "$env:USERNAME:(OI)(CI)M" | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  ✓ 已授权写权限——重启 IDE 后自动下载 node.exe"
            $changed = $true
        } else {
            Write-Host "  ✗ icacls 授权失败（确认以管理员运行）"
        }
    }
}

if ($changed) {
    Write-Host ''
    Write-Host '完成：请完全退出并重启 Qoder IDE（扩展 host 将自动下载 node.exe，弹窗应消失）'
} else {
    Write-Host ''
    Write-Host '无需修改（node.exe 已存在或目录不存在）'
}
