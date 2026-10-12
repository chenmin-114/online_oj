#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$vmName = 'JCOJ-Judge-Node'
$virtualBoxVersion = '7.2.20'
$virtualBoxBuild = '175154'
$virtualBoxUrl = "https://download.virtualbox.org/virtualbox/$virtualBoxVersion/VirtualBox-$virtualBoxVersion-$virtualBoxBuild-Win.exe"
$virtualBoxSha256 = 'a81777d2b36380ce042a29e9c554cf032eb46a793f62e3cc82e7411e535c2c26'
$ubuntuIsoUrl = 'https://releases.ubuntu.com/22.04/ubuntu-22.04.5-live-server-amd64.iso'
$ubuntuIsoSha256 = '9bc6028870aef3f74f4e16b900008179e78b130e6b0b9a140635434a46aa98b0'
$guestInstallUrl = 'https://jc-oj.online/downloads/judge-node-guest-install.sh'
$guestInstallSha256 = '__GUEST_INSTALL_SHA256__'
$sourceDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$pairingPath = Join-Path $sourceDirectory 'pairing.json'

function Stop-WithMessage([string]$message) {
  Write-Host "`n安装未完成：$message" -ForegroundColor Red
  Write-Host '没有切换网站判题服务，也不会影响学生当前使用。' -ForegroundColor Yellow
  Read-Host '按回车键关闭'
  exit 1
}

function Get-Sha256([string]$path) {
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Download-Verified([string]$url, [string]$path, [string]$sha256) {
  if ((Test-Path -LiteralPath $path) -and (Get-Sha256 $path) -eq $sha256) { return }
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
  Write-Host "正在安全下载：$url"
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $path
  if ((Get-Sha256 $path) -ne $sha256) {
    Remove-Item -LiteralPath $path -Force
    throw '下载文件的安全校验失败，已删除文件'
  }
}

function Invoke-VBox([string[]]$arguments) {
  & $script:vboxManage @arguments
  if ($LASTEXITCODE -ne 0) { throw "VirtualBox 操作失败：$($arguments -join ' ')" }
}

try {
  if (-not (Test-Path -LiteralPath $pairingPath)) { Stop-WithMessage '安装包缺少 pairing.json' }
  $pairing = Get-Content -LiteralPath $pairingPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($pairing.format -ne 'jc-oj-judge-node-pairing-v1' -or $pairing.pairingCode -notmatch '^JCN1_[A-Za-z0-9_-]{43}$') {
    Stop-WithMessage '一次性配对文件格式不正确'
  }
  if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge [int64]$pairing.expiresAt) {
    Stop-WithMessage '安装包已经过期，请从管理后台重新生成'
  }

  $computer = Get-CimInstance Win32_ComputerSystem
  $processor = Get-CimInstance Win32_Processor | Select-Object -First 1
  $ramGb = [math]::Floor($computer.TotalPhysicalMemory / 1GB)
  if ($ramGb -lt 8) { Stop-WithMessage '电脑内存低于8GB，不适合安全运行本地判题节点' }
  # 启用 Hyper-V/VBS 后，Windows 可能会向 WMI 隐藏真实 CPU 虚拟化能力，
  # 此时 VirtualizationFirmwareEnabled 会错误地返回 False，但 HypervisorPresent=True
  # 已足以证明固件虚拟化正在工作。两种可靠信号任意一个为 True 即可继续。
  $firmwareVirtualizationEnabled = $processor.VirtualizationFirmwareEnabled -eq $true
  $windowsHypervisorActive = $computer.HypervisorPresent -eq $true
  if (-not $firmwareVirtualizationEnabled -and -not $windowsHypervisorActive) {
    Stop-WithMessage 'CPU虚拟化尚未在BIOS中开启，请开启 Intel VT-x/AMD-V 后重新运行安装包'
  }
  if ($windowsHypervisorActive -and -not $firmwareVirtualizationEnabled) {
    Write-Host '已通过 Windows 虚拟机监控程序确认 CPU 虚拟化处于启用状态。' -ForegroundColor Green
  }

  Add-Type -AssemblyName System.Windows.Forms
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = '选择机创OJ判题节点的安装磁盘或文件夹（建议至少剩余25GB）'
  $dialog.ShowNewFolderButton = $true
  if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { Stop-WithMessage '没有选择安装位置' }
  $selected = [IO.Path]::GetFullPath($dialog.SelectedPath)
  $drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($selected).Substring(0,1))
  if (-not $drive -or $drive.Free -lt 25GB) { Stop-WithMessage '所选磁盘剩余空间不足25GB' }
  $installRoot = Join-Path $selected 'JCOJ-JudgeNode'
  if (Test-Path -LiteralPath $installRoot) { Stop-WithMessage "目标目录已经存在：$installRoot；为防止覆盖数据，安装器不会继续" }
  New-Item -ItemType Directory -Path $installRoot | Out-Null
  $cacheDirectory = Join-Path $installRoot 'downloads'
  New-Item -ItemType Directory -Path $cacheDirectory | Out-Null

  $script:vboxManage = Join-Path $env:ProgramFiles 'Oracle\VirtualBox\VBoxManage.exe'
  if (-not (Test-Path -LiteralPath $script:vboxManage)) {
    $virtualBoxInstaller = Join-Path $cacheDirectory 'VirtualBox-Win.exe'
    Download-Verified $virtualBoxUrl $virtualBoxInstaller $virtualBoxSha256
    Write-Host '正在安装经过校验的 Oracle VirtualBox，网络驱动安装期间网络可能短暂断开...'
    $process = Start-Process -FilePath $virtualBoxInstaller -ArgumentList '--silent' -Wait -PassThru
    if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $script:vboxManage)) {
      Stop-WithMessage "VirtualBox安装失败，退出码 $($process.ExitCode)"
    }
  }

  $existing = & $script:vboxManage list vms
  if ($existing -match [regex]::Escape('"' + $vmName + '"')) {
    Stop-WithMessage "已经存在名为 $vmName 的虚拟机，安装器不会覆盖"
  }

  $isoPath = Join-Path $cacheDirectory 'ubuntu-22.04.5-live-server-amd64.iso'
  Download-Verified $ubuntuIsoUrl $isoPath $ubuntuIsoSha256
  $guestInstallerPath = Join-Path $cacheDirectory 'judge-node-guest-install.sh'
  Download-Verified $guestInstallUrl $guestInstallerPath $guestInstallSha256

  $maxSlots = if ($ramGb -ge 30) { 8 } elseif ($ramGb -ge 16) { 4 } else { 2 }
  $vmMemory = if ($ramGb -ge 30) { 10240 } elseif ($ramGb -ge 16) { 6144 } else { 4096 }
  $logicalProcessors = [int]$computer.NumberOfLogicalProcessors
  $vmCpus = [math]::Max(2, [math]::Min(10, [math]::Floor($logicalProcessors / 2)))
  $pairing.maxSlots = $maxSlots
  $pairingJson = $pairing | ConvertTo-Json -Compress
  $pairingBytes = [Text.Encoding]::UTF8.GetBytes($pairingJson)
  $pairingB64 = [Convert]::ToBase64String($pairingBytes).TrimEnd('=').Replace('+','-').Replace('/','_')

  $guestPasswordAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $random = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($random)
  $rng.Dispose()
  $guestPassword = -join ($random | Select-Object -First 24 | ForEach-Object { $guestPasswordAlphabet[$_ % $guestPasswordAlphabet.Length] })

  Write-Host "正在创建隔离虚拟机，数据保存到：$installRoot"
  Invoke-VBox @('createvm', '--name', $vmName, '--ostype', 'Ubuntu22_LTS_64', '--basefolder', $installRoot, '--register')
  Invoke-VBox @('modifyvm', $vmName, '--memory', "$vmMemory", '--cpus', "$vmCpus", '--ioapic', 'on', '--firmware', 'efi',
    '--nic1', 'nat', '--cable-connected1', 'on', '--clipboard-mode', 'disabled', '--draganddrop', 'disabled',
    '--audio-enabled', 'off', '--usb', 'off', '--vrde', 'off', '--recording', 'off')
  $diskPath = Join-Path $installRoot "$vmName\judge-node.vdi"
  Invoke-VBox @('createmedium', 'disk', '--filename', $diskPath, '--size', '40960', '--format', 'VDI', '--variant', 'Standard')
  Invoke-VBox @('storagectl', $vmName, '--name', 'SATA', '--add', 'sata', '--controller', 'IntelAhci')
  Invoke-VBox @('storageattach', $vmName, '--storagectl', 'SATA', '--port', '0', '--device', '0', '--type', 'hdd', '--medium', $diskPath)

  $postCommand = "curl -fsSL '$guestInstallUrl' -o /tmp/jc-install.sh && echo '$guestInstallSha256  /tmp/jc-install.sh' | sha256sum -c --strict && echo '$guestPassword' | sudo -S bash /tmp/jc-install.sh '$pairingB64'"
  Invoke-VBox @('unattended', 'install', $vmName, "--iso=$isoPath", '--user=jcnode', "--password=$guestPassword",
    '--full-user-name=JC OJ Node', '--hostname=jc-oj-node.local', '--locale=en_US', '--country=CN',
    '--time-zone=Asia/Hong_Kong', '--install-additions', "--post-install-command=$postCommand")

  $launcherSource = Join-Path $sourceDirectory 'Start-JCOJJudgeNode.ps1'
  $launcherTarget = Join-Path $installRoot 'Start-JCOJJudgeNode.ps1'
  Copy-Item -LiteralPath $launcherSource -Destination $launcherTarget
  $taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$launcherTarget`""
  & schtasks.exe /Create /SC ONLOGON /TN 'JCOJ Judge Node' /TR $taskCommand /F | Out-Null

  Invoke-VBox @('startvm', $vmName, '--type', 'headless')
  Remove-Item -LiteralPath $pairingPath -Force
  Write-Host "`n机创OJ判题节点正在全自动安装。" -ForegroundColor Green
  Write-Host 'Ubuntu、Docker和Judge0通常需要20～45分钟完成，电脑请保持开机和联网。'
  Write-Host '安装成功后节点会自动出现在管理后台；在节点显示“在线可用”前，网站不会向它发送任务。'
  Write-Host "安装目录：$installRoot"
  Read-Host '按回车键关闭本窗口（后台安装不会停止）'
} catch {
  Stop-WithMessage $_.Exception.Message
}
