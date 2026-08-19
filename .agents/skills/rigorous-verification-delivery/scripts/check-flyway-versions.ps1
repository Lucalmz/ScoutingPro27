# Check Flyway migration files for versioning order, naming consistency, and potential conflicts.
param (
    [string]$SearchRoot = "."
)

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " Scanning Flyway Migrations in: $SearchRoot" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

$pattern = "^V([0-9]+(?:_[0-9]+)*)__(.+)\.(sql|java)$"
$excludePatterns = @("\\target\\", "\\build\\", "\\bin\\", "\\out\\", "\\\.git\\", "\\node_modules\\")

$rawFiles = Get-ChildItem -Path $SearchRoot -Recurse -File -Include "V*__*.sql", "V*__*.java" -ErrorAction SilentlyContinue

$files = $rawFiles | Where-Object {
    $fullPath = $_.FullName
    $excluded = $false
    foreach ($exc in $excludePatterns) {
        if ($fullPath -match $exc) {
            $excluded = $true
            break
        }
    }
    -not $excluded
}

if (-not $files -or $files.Count -eq 0) {
    Write-Host "[INFO] No Flyway migration source files found matching V*__*.sql or V*__*.java." -ForegroundColor Yellow
    exit 0
}

$migrationList = @()
$hasDuplicate = $false
$seenVersions = @{}

foreach ($f in $files) {
    if ($f.Name -match $pattern) {
        $rawVersion = $Matches[1]
        $desc = $Matches[2]
        $ext = $Matches[3]
        $versionKey = $rawVersion.Replace('_', '.')

        if ($seenVersions.ContainsKey($rawVersion)) {
            Write-Host "[ERROR] DUPLICATE VERSION DETECTED!" -ForegroundColor Red
            Write-Host "  Version: V$rawVersion" -ForegroundColor Red
            Write-Host "  File 1:  $($seenVersions[$rawVersion])" -ForegroundColor Red
            Write-Host "  File 2:  $($f.FullName)" -ForegroundColor Red
            $hasDuplicate = $true
        } else {
            $seenVersions[$rawVersion] = $f.FullName
        }

        # Calculate a numeric sorting weight: e.g. "10_1" -> [10, 1]
        $versionParts = ($rawVersion -split '_') | ForEach-Object { [int]$_ }

        $migrationList += [PSCustomObject]@{
            Version      = "V$rawVersion"
            VersionParts = $versionParts
            Description  = $desc
            Extension    = $ext
            FileName     = $f.Name
            FullPath     = $f.FullName
        }
    } else {
        Write-Host "[WARN] File matches prefix but violates Flyway standard naming: $($f.Name)" -ForegroundColor Yellow
    }
}

# Sort numerically
$sortedMigrations = $migrationList | Sort-Object -Property @{Expression={ $_.VersionParts[0] }}, @{Expression={ if ($_.VersionParts.Count -gt 1) { $_.VersionParts[1] } else { 0 } }}

Write-Host "`nDiscovered Source Migrations (Sorted):" -ForegroundColor Green
$sortedMigrations | Format-Table Version, Description, Extension, FileName -AutoSize

if ($hasDuplicate) {
    Write-Host "`n[FATAL] Found version conflicts! Please resolve before proceeding." -ForegroundColor Red
    exit 1
} else {
    $latest = $sortedMigrations[-1]
    Write-Host "`n[SUCCESS] No version conflicts found. Total migrations: $($sortedMigrations.Count)" -ForegroundColor Green
    Write-Host "[INFO] Latest Version: $($latest.Version) ($($latest.FileName))" -ForegroundColor Cyan
    exit 0
}
