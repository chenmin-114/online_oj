$ErrorActionPreference = 'Continue'
$vbox = Join-Path $env:ProgramFiles 'Oracle\VirtualBox\VBoxManage.exe'
if (-not (Test-Path -LiteralPath $vbox)) {
  Write-Host '没有找到 Oracle VirtualBox，请先完成判题节点安装。' -ForegroundColor Red
  Read-Host '按回车键关闭'
  exit 1
}
$info = & $vbox showvminfo 'JCOJ-Judge-Node' --machinereadable 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host '没有找到 JCOJ-Judge-Node 虚拟机，请先完成判题节点安装。' -ForegroundColor Red
  Read-Host '按回车键关闭'
  exit 1
}
$stateLine = $info | Where-Object { $_ -like 'VMState=*' } | Select-Object -First 1
if ($stateLine -match 'VMState="(poweroff|saved|aborted)"') {
  Write-Host '正在启动机创OJ本地判题节点...'
  & $vbox startvm 'JCOJ-Judge-Node' --type headless
  if ($LASTEXITCODE -ne 0) {
    Write-Host '节点启动失败，请检查 VirtualBox。' -ForegroundColor Red
    Read-Host '按回车键关闭'
    exit 1
  }
  Write-Host '节点已启动。通常需要1～3分钟才会在管理后台显示“在线可用”。' -ForegroundColor Green
} elseif ($stateLine -match 'VMState="running"') {
  Write-Host '机创OJ本地判题节点已经在运行。' -ForegroundColor Green
} else {
  Write-Host "节点当前状态：$stateLine，请稍后重试。" -ForegroundColor Yellow
}
Read-Host '按回车键关闭'
