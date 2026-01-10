$path = Read-Host "Enter file path (example: src/core/interfaces/exchange.interface.ts)"

$directory = Split-Path $path -Parent
$file = Split-Path $path -Leaf

# Create directory if not exists
if (!(Test-Path $directory)) {
    Write-Host "Creating directory: $directory"
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
} else {
    Write-Host "Directory exists: $directory"
}

# Create file if not exists
if (!(Test-Path $path)) {
    Write-Host "Creating file: $path"
    New-Item -ItemType File -Path $path -Force | Out-Null
} else {
    Write-Host "File already exists (will not overwrite): $path"
}
