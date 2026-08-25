$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = $PSScriptRoot
$out = Join-Path $root "dist"
$shared = @("content.js", "content.css", "popup.html", "popup.css", "popup.js", "icons")

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null

function New-Zip($sourceDir, $zipPath) {
    $zip = [System.IO.Compression.ZipFile]::Open($zipPath, "Create")
    try {
        $base = (Resolve-Path $sourceDir).Path.TrimEnd("\") + "\"
        foreach ($file in Get-ChildItem $sourceDir -Recurse -File) {
            $rel = $file.FullName.Substring($base.Length).Replace("\", "/")
            [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $zip, $file.FullName, $rel, "Optimal")
        }
    } finally {
        $zip.Dispose()
    }
}

function Build-Target($name, $manifest) {
    $stage = Join-Path $out $name
    New-Item -ItemType Directory -Path $stage | Out-Null
    foreach ($item in $shared) {
        Copy-Item (Join-Path $root $item) -Destination $stage -Recurse
    }
    Copy-Item (Join-Path $root $manifest) -Destination (Join-Path $stage "manifest.json")

    $zip = Join-Path $out "x-blur-mode-$name.zip"
    New-Zip $stage $zip
    Write-Host "  $zip"
    Write-Host "    unpacked: $stage"
}

Write-Host "Packaging:"
Build-Target "chrome"  "manifest.json"
Build-Target "firefox" "manifest.firefox.json"
