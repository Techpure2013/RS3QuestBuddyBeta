# RS3DB.ps1 - Open SSH tunnel for Postgres (for Drizzle Studio)
# Reads RS3_SSH_HOST from .env file, environment variable, or -SshHost parameter

param(
  [string]$User = "root",
  [string]$SshHost = "",
  [int]$SshPort = 22,
  [int]$LocalPort = 5432,         # local port to forward
  [int]$RemotePort = 5432,        # VPS Postgres port
  [string]$RemoteHost = "127.0.0.1",
  [string]$KeyPath = "",          # Empty = password auth, or pass your key path
  [switch]$VerboseSSH
)

# Load from .env file if it exists
$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
      $key = $matches[1].Trim()
      $val = $matches[2].Trim()
      if ($key -eq "RS3_SSH_HOST" -and -not $SshHost) {
        $SshHost = $val
      }
    }
  }
}

# Fall back to environment variable
if (-not $SshHost) { $SshHost = $env:RS3_SSH_HOST }

if (-not $SshHost) {
  Write-Host "ERROR: No SSH host specified."
  Write-Host "Add RS3_SSH_HOST=your.server.ip to .env, set env variable, or use -SshHost parameter."
  Read-Host "Press Enter to exit"
  exit 1
}

function Test-PortFree {
  param([int]$Port)
  try {
    $l = [System.Net.Sockets.TcpListener]::new(
      [System.Net.IPAddress]::Loopback, $Port
    ); $l.Start(); $l.Stop(); return $true
  } catch { return $false }
}

$ssh = Get-Command ssh -ErrorAction SilentlyContinue
if (-not $ssh) {
  Write-Host "ERROR: OpenSSH client not found."
  Read-Host "Press Enter to exit"
  exit 1
}

if (-not (Test-PortFree -Port $LocalPort)) {
  Write-Host "ERROR: Local port ${LocalPort} is in use. Try -LocalPort 6543."
  Read-Host "Press Enter to exit"
  exit 1
}

$sshArgs = @("-N", "-p", "$SshPort", "-L", "${LocalPort}:${RemoteHost}:${RemotePort}")
if ($KeyPath) {
  if (Test-Path $KeyPath) { $sshArgs += @("-i", $KeyPath) }
  else { Write-Host "WARNING: Key not found at $KeyPath. Using password auth." }
}
if ($VerboseSSH) { $sshArgs += "-v" }
$sshArgs += "${User}@${SshHost}"

Write-Host "Opening SSH tunnel for Postgres:"
Write-Host "  Local:  postgres://127.0.0.1:${LocalPort}"
Write-Host "  Remote: [hidden]:${RemotePort}"
Write-Host "Keep this window open. Press Ctrl+C to close."
Write-Host ""

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $ssh.Source
$psi.Arguments = ($sshArgs -join " ")
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false

$proc = [System.Diagnostics.Process]::Start($psi)
while (-not $proc.HasExited) {
  $line = $proc.StandardError.ReadLine()
  if ($null -ne $line) { Write-Host $line }
  Start-Sleep -Milliseconds 100
}
if ($proc.ExitCode -ne 0) {
  Write-Host "`nSSH exited with code $($proc.ExitCode)."
  Read-Host "Press Enter to exit"
}
