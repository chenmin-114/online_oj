$ErrorActionPreference = 'SilentlyContinue'
$vbox = Join-Path $env:ProgramFiles 'Oracle\VirtualBox\VBoxManage.exe'
if (-not (Test-Path -LiteralPath $vbox)) { exit 1 }
$info = & $vbox showvminfo 'JCOJ-Judge-Node' --machinereadable 2>$null
if ($LASTEXITCODE -ne 0) { exit 1 }
$stateLine = $info | Where-Object { $_ -like 'VMState=*' } | Select-Object -First 1
if ($stateLine -match 'VMState="(poweroff|saved|aborted)"') {
  & $vbox startvm 'JCOJ-Judge-Node' --type headless | Out-Null
}
