# Sylloom for Windows 11 x64. Run from a downloaded/cloned source directory.
[CmdletBinding()]
param(
    [switch]$DictationOnly, [switch]$SkipModels, [switch]$SkipRuntimes,
    [switch]$NoLink, [switch]$NoPath, [switch]$Check, [switch]$Help
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($Help) {
    Write-Host 'Usage: .\install.ps1 [-DictationOnly | -SkipModels] [-SkipRuntimes] [-NoLink] [-NoPath] [-Check]'
    Write-Host 'Installs Node.js, CPU runtimes and local models for the current user. No admin access is required.'
    Write-Host '-Check only inspects requirements. SYLLOOM_HOME and SYLLOOM_BIN_DIR override local storage and command locations.'
    exit 0
}
if ($env:OS -ne 'Windows_NT' -or [Environment]::OSVersion.Version.Build -lt 22000 -or
    ($env:PROCESSOR_ARCHITEW6432 -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64') -or
    (-not $env:PROCESSOR_ARCHITEW6432 -and $env:PROCESSOR_ARCHITECTURE -ne 'AMD64')) {
    throw 'Use Windows 11 x64. On macOS run ./install.sh instead.'
}
if ($DictationOnly -and $SkipModels) { throw 'Choose either -DictationOnly or -SkipModels.' }
$project = $PSScriptRoot
$storage = if ($env:SYLLOOM_HOME) { $env:SYLLOOM_HOME } elseif ($env:MEETING_HOME) { $env:MEETING_HOME } else { Join-Path $project 'data' }
$storage = [IO.Path]::GetFullPath($storage)
$headers = @{ 'User-Agent'='Sylloom-installer'; 'Accept'='application/vnd.github+json' }
if ($env:SYLLOOM_GITHUB_TOKEN) { $headers['Authorization'] = 'Bearer '+$env:SYLLOOM_GITHUB_TOKEN }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed (exit $LASTEXITCODE). Installation stopped; existing data is preserved." }
}
function Test-Node([string]$Executable) {
    if (-not $Executable) { return $false }
    try {
        & $Executable -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)" 2>$null
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}
function Test-Runtime([string]$Executable) {
    # Windows PowerShell 5 treats redirected native stderr as ErrorRecords.
    # Both upstream --help commands legitimately write usage to stderr.
    $ErrorActionPreference = 'Continue'
    try { & $Executable --help *> $null; return $LASTEXITCODE -eq 0 }
    catch { return $false }
}
function Save-Verified([string]$Url, [string]$Target, [string]$Hash, [long]$Size = 0) {
    if ($Hash -notmatch '^[a-fA-F0-9]{64}$') { throw 'The publisher did not provide a SHA-256. Download refused.' }
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Target -TimeoutSec 600
        if ($Size -gt 0 -and (Get-Item -LiteralPath $Target).Length -ne $Size) { throw 'Download size does not match the publisher.' }
        if ((Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash -ine $Hash) { throw 'Download SHA-256 does not match the publisher.' }
    } catch { Remove-Item -LiteralPath $Target -Force -ErrorAction SilentlyContinue; throw }
}
function Install-Node {
    $base = 'https://nodejs.org/dist/latest-v24.x/'
    $checksums = (Invoke-WebRequest -UseBasicParsing -Uri ($base+'SHASUMS256.txt') -TimeoutSec 30).Content
    $match = [regex]::Match($checksums, '(?m)^([a-f0-9]{64})\s+(node-v24\.[0-9]+\.[0-9]+-win-x64\.zip)\r?$')
    if (-not $match.Success) { throw 'Could not find the official Node.js 24 x64 archive.' }
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ('sylloom-node-'+[guid]::NewGuid())
    try {
        [void](New-Item -ItemType Directory -Path $temporary)
        $archive = Join-Path $temporary 'node.zip'
        Save-Verified ($base+$match.Groups[2].Value) $archive $match.Groups[1].Value
        Expand-Archive -LiteralPath $archive -DestinationPath $temporary
        $folder = Join-Path $temporary ([IO.Path]::GetFileNameWithoutExtension($match.Groups[2].Value))
        $parent = Join-Path $env:LOCALAPPDATA 'Sylloom\node'
        [void](New-Item -ItemType Directory -Path $parent -Force)
        $target = Join-Path $parent ([IO.Path]::GetFileName($folder))
        if (-not (Test-Path -LiteralPath $target)) { Move-Item -LiteralPath $folder -Destination $target }
        return Join-Path $target 'node.exe'
    } finally { Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue }
}
function Resolve-Runtime([string]$Binary, [string]$Repo, [string]$Pattern, [string]$Saved) {
    if ($Saved -and (Get-Command $Saved -CommandType Application -ErrorAction SilentlyContinue)) { return $Saved }
    $available = Get-Command $Binary -CommandType Application -ErrorAction SilentlyContinue
    if ($available) { return $available.Source }
    if ($Check -or $SkipRuntimes) { throw "$Binary is missing. Run the installer without -SkipRuntimes to obtain the official CPU build." }
    # Latest tags are not always binary releases. Select the newest published
    # release containing the exact CPU asset, including upstream nightly builds.
    # Never substitute a CUDA/Vulkan/BLAS archive.
    $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=20" -Headers $headers -TimeoutSec 30
    $asset = $null
    foreach ($release in $releases) {
        if ($release.draft) { continue }
        $asset = @($release.assets | Where-Object { $_.name -cmatch $Pattern } | Select-Object -First 1)
        if ($asset.Count) { $asset = $asset[0]; break }
    }
    if (-not $asset -or -not $asset.digest -or $asset.digest -notmatch '^sha256:([a-f0-9]{64})$') { throw "No SHA-256 verified CPU archive was published for $Repo." }
    $digest = $Matches[1]
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ('sylloom-runtime-'+[guid]::NewGuid())
    try {
        [void](New-Item -ItemType Directory -Path $temporary)
        $archive = Join-Path $temporary 'runtime.zip'
        Save-Verified $asset.browser_download_url $archive $digest $asset.size
        $expanded = Join-Path $temporary 'expanded'
        Expand-Archive -LiteralPath $archive -DestinationPath $expanded
        $found = @(Get-ChildItem -LiteralPath $expanded -Recurse -File -Filter $Binary)
        if ($found.Count -ne 1) { throw "The publisher archive does not contain a unique $Binary." }
        # Keep the entire bundle: ggml and runtime DLLs must stay beside it.
        $parent = Join-Path $storage 'runtimes'
        [void](New-Item -ItemType Directory -Path $parent -Force)
        $target = Join-Path $parent (([IO.Path]::GetFileNameWithoutExtension($asset.name))+'-'+$digest.Substring(0,12))
        $relative = $found[0].FullName.Substring($expanded.Length).TrimStart('\')
        if (-not (Test-Path -LiteralPath $target)) { Move-Item -LiteralPath $expanded -Destination $target }
        return Join-Path $target $relative
    } finally { Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue }
}

$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
$node = if ($nodeCommand) { $nodeCommand.Source } else { '' }
if (-not (Test-Node $node)) {
    $cache = Join-Path $env:LOCALAPPDATA 'Sylloom\node'
    if (Test-Path -LiteralPath $cache) {
        foreach ($folder in (Get-ChildItem -LiteralPath $cache -Directory -Filter 'node-v24.*-win-x64' | Sort-Object Name -Descending)) {
            $candidate = Join-Path $folder.FullName 'node.exe'
            if (Test-Node $candidate) { $node = $candidate; break }
        }
    }
}
if (-not (Test-Node $node)) {
    if ($Check) { throw 'Node.js 22.18 or later is missing. The installer can obtain Node.js 24 without admin rights.' }
    $node = Install-Node
}
if (-not (Test-Node $node)) { throw 'Node.js setup failed.' }
$nodeDirectory = Split-Path -Parent $node
$env:PATH = $nodeDirectory+';'+$env:PATH
$npm = Join-Path $nodeDirectory 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path -LiteralPath $npm)) { throw 'npm is missing from the selected Node.js installation.' }
$saved = @{}
$settingsFile = Join-Path $storage 'settings.json'
if (Test-Path -LiteralPath $settingsFile) { $saved = Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json }
$whisperSaved = if ($saved.PSObject.Properties['whisperBinary']) { $saved.whisperBinary } else { '' }
$llamaSaved = if ($saved.PSObject.Properties['llmBinary']) { $saved.llmBinary } else { '' }
$whisper = Resolve-Runtime 'whisper-server.exe' 'ggml-org/whisper.cpp' '^whisper-bin-x64\.zip$' $whisperSaved
$llama = Resolve-Runtime 'llama-server.exe' 'ggml-org/llama.cpp' '^llama-.*-bin-win-cpu-x64\.zip$' $llamaSaved
foreach ($runtime in @($whisper,$llama)) {
    if (-not (Test-Runtime $runtime)) { throw "$runtime could not start. Check CPU compatibility and the Microsoft Visual C++ x64 runtime (https://aka.ms/vc14/vc_redist.x64.exe)." }
}
if ($Check) { Write-Host 'Requirements ready. No changes made.'; exit 0 }
Push-Location -LiteralPath $project
try {
    Invoke-Checked $node @($npm,'ci')
    Invoke-Checked $node @($npm,'run','build')
    $env:SYLLOOM_SETUP_WHISPER = $whisper
    $env:SYLLOOM_SETUP_LLAMA = $llama
    $env:SYLLOOM_HOME = $storage
    $save = 'const {settings,saveSettings}=await import("./dist/store.js");const s=await settings();s.whisperBinary=process.env.SYLLOOM_SETUP_WHISPER;s.llmBinary=process.env.SYLLOOM_SETUP_LLAMA;await saveSettings(s);'
    $save | & $node --input-type=module -
    if ($LASTEXITCODE -ne 0) { throw 'Could not save runtime settings.' }
    if (-not $SkipModels) {
        if ($DictationOnly) {
            Invoke-Checked $node @('sylloom','models','install','dictation-whisper','--keep-selection')
            Invoke-Checked $node @('sylloom','models','install','formatter','--keep-selection')
        } else { Invoke-Checked $node @('sylloom','models','install','all','--keep-selection') }
    }
    if (-not $NoLink) {
        $arguments = @('sylloom','install')
        if ($NoPath) { $arguments += '--no-path' }
        Invoke-Checked $node $arguments
    }
} finally {
    Pop-Location
    Remove-Item Env:SYLLOOM_SETUP_WHISPER,Env:SYLLOOM_SETUP_LLAMA -ErrorAction SilentlyContinue
}
if ($NoLink) { Write-Host 'Sylloom is ready. Run .\sylloom.cmd in this directory.' }
elseif ($NoPath) { Write-Host 'Sylloom is ready. Add the command directory to PATH, or use .\sylloom.cmd here.' }
else { Write-Host 'Sylloom is ready. Open a new terminal and run sylloom, or use .\sylloom.cmd here.' }
Write-Host 'Allow microphone access for desktop apps in Windows Settings. CPU processing depends on your hardware.'
