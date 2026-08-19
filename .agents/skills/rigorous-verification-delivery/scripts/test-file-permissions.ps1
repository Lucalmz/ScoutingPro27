# Test Windows file/directory permissions, ACLs, and read/write availability for current user.
param (
    [Parameter(Mandatory=$true)]
    [string]$Path
)

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " Testing File Permissions on: $Path" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

if (-not (Test-Path -Path $Path)) {
    Write-Host "[ERROR] Target path does not exist: $Path" -ForegroundColor Red
    exit 1
}

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
Write-Host "[INFO] Current Process Identity: $currentUser" -ForegroundColor Gray

# 1. Read ACL
Write-Host "`n1. Inspecting Access Control List (ACL)..." -ForegroundColor Yellow
try {
    $acl = Get-Acl -Path $Path
    Write-Host "   Owner: $($acl.Owner)" -ForegroundColor Green
    Write-Host "   Access Rules Count: $($acl.Access.Count)" -ForegroundColor Green
    $acl.Access | Format-Table IdentityReference, FileSystemRights, AccessControlType, IsInherited -AutoSize
} catch {
    Write-Host "[FAIL] Failed to retrieve ACL: $_" -ForegroundColor Red
}

# 2. Test Read
Write-Host "2. Testing Read Access..." -ForegroundColor Yellow
$item = Get-Item -Path $Path
if ($item -is [System.IO.FileInfo]) {
    try {
        $content = Get-Content -Path $Path -TotalCount 3 -ErrorAction Stop
        Write-Host "   [PASS] Read succeeded. First line sample: $($content | Select-Object -First 1)" -ForegroundColor Green
    } catch {
        Write-Host "   [FAIL] Read failed: $_" -ForegroundColor Red
    }
} else {
    try {
        $children = Get-ChildItem -Path $Path -ErrorAction Stop
        Write-Host "   [PASS] Directory list succeeded. Children count: $($children.Count)" -ForegroundColor Green
    } catch {
        Write-Host "   [FAIL] Directory list failed: $_" -ForegroundColor Red
    }
}

# 3. Test Write/Append Probe
Write-Host "3. Testing Write/Append Probe..." -ForegroundColor Yellow
$testProbeFile = if ($item -is [System.IO.DirectoryInfo]) { Join-Path $Path ".__perm_probe_test.tmp" } else { $Path }

try {
    if ($item -is [System.IO.DirectoryInfo]) {
        Set-Content -Path $testProbeFile -Value "permission probe test $(Get-Date)" -ErrorAction Stop
        Remove-Item -Path $testProbeFile -Force -ErrorAction Stop
        Write-Host "   [PASS] Write & delete probe succeeded inside directory." -ForegroundColor Green
    } else {
        # For file, open with write share
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite)
        $fs.Close()
        Write-Host "   [PASS] File opened for ReadWrite without ACL lock error." -ForegroundColor Green
    }
} catch {
    Write-Host "   [FAIL] Write probe failed! Potential owner lockout or permission restriction: $_" -ForegroundColor Red
}

Write-Host "`n[DONE] Permission test completed." -ForegroundColor Cyan
