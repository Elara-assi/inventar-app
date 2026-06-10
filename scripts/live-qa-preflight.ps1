param(
  [switch]$ResetVolumes,
  [switch]$SkipInstall,
  [switch]$SkipBuild,
  [string]$ApiUrl = "http://127.0.0.1:8000",
  [string]$WebUrl = "http://127.0.0.1:3002"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Assert-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' is not available in PATH."
  }
}

function Invoke-Checked {
  param([string[]]$Command)
  Write-Host ("$ " + ($Command -join " ")) -ForegroundColor DarkGray
  & $Command[0] @($Command | Select-Object -Skip 1)
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $($Command -join ' ')"
  }
}

if (-not (Test-Path "docker-compose.yml")) {
  throw "Run this script from the Inventar repository root."
}

Write-Step "Checking required commands"
Assert-Command "git"
Assert-Command "node"
Assert-Command "npm"
Assert-Command "python"
Assert-Command "docker"

$env:COMPOSE_PROJECT_NAME = "inventar-app"
$env:INVENTAR_API = $ApiUrl
$env:INVENTAR_UPLOAD_HOST_ROOT = (Join-Path (Get-Location) "storage\uploads").Replace("\", "/")
$env:NEXT_PUBLIC_API_URL = $ApiUrl
$env:NEXT_PUBLIC_APP_VERSION = if ($env:NEXT_PUBLIC_APP_VERSION) { $env:NEXT_PUBLIC_APP_VERSION } else { "local-live-qa" }
$env:AUTH_SECRET = if ($env:AUTH_SECRET) { $env:AUTH_SECRET } else { "local-live-qa-change-me" }
$env:PYTHONPATH = if ($env:PYTHONPATH) { "apps/api;$env:PYTHONPATH" } else { "apps/api" }

Write-Step "Repository state"
Invoke-Checked @("git", "status", "--short", "--branch")
Invoke-Checked @("git", "diff", "--name-only")

Write-Step "Static preflight"
Invoke-Checked @("npm", "run", "smoke")
if (-not $SkipBuild) {
  Invoke-Checked @("npm", "run", "build")
}
Invoke-Checked @("python", "-m", "py_compile", "apps/api/app/main.py", "apps/api/app/db.py", "apps/api/app/logic.py", "apps/api/app/settings.py", "apps/api/app/security.py", "apps/api/app/migrations.py")
Invoke-Checked @("python", "scripts\ai-guardrail-test.py")

if (-not $SkipInstall) {
  Write-Step "Installing Python test dependencies"
  Invoke-Checked @("python", "-m", "pip", "install", "-r", "apps/api/requirements.txt", "pytest", "requests")
}

Write-Step "Ensuring Docker network ELARA exists"
$networkExists = docker network ls --format "{{.Name}}" | Where-Object { $_ -eq "ELARA" }
if (-not $networkExists) {
  Invoke-Checked @("docker", "network", "create", "ELARA")
}

if ($ResetVolumes) {
  Write-Step "Resetting disposable Docker volumes"
  Invoke-Checked @("docker", "compose", "down", "-v")
}

Write-Step "Starting disposable stack"
Invoke-Checked @("docker", "compose", "up", "--build", "-d", "postgres", "redis", "api", "web")

Write-Step "Waiting for API health"
$health = $null
for ($i = 1; $i -le 40; $i++) {
  try {
    $health = Invoke-RestMethod -Uri "$ApiUrl/health" -TimeoutSec 5
    if ($health.ok -and $health.database) {
      break
    }
  } catch {
    Start-Sleep -Seconds 3
  }
}

if (-not $health -or -not $health.ok -or -not $health.database) {
  docker compose ps
  throw "API did not become healthy at $ApiUrl."
}

$health | ConvertTo-Json -Depth 5

Write-Step "Running API and sync tests"
Invoke-Checked @("python", "-m", "pytest", "apps/api/tests")
Invoke-Checked @("python", "scripts\receipt-sync-test.py")
Invoke-Checked @("python", "scripts\bundle-sync-test.py")

Write-Step "Live QA preflight complete"
Write-Host "API: $ApiUrl"
Write-Host "Web: $WebUrl"
Write-Host "Next: run docs/ROOM_TEST_V01.md and fill the evidence packet."
