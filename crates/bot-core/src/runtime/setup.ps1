$dir = $env:BOT_CODE_SETUP_DIR
for ($try = 0; -not $lock; $try++) {
    try {
        $lock = [System.IO.File]::Open((Join-Path $dir 'lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    } catch {
        if ($try -ge 100) { throw }
        Start-Sleep -Milliseconds 50
    }
}
# Bot Code reads a free lock as a stopped setup only once this file exists.
Set-Content -Encoding ascii -Path (Join-Path $dir 'pid') -Value $PID
# cmd.exe merges stderr, which Windows PowerShell would otherwise rewrap as error records.
$code = 0
if ($env:BOT_CODE_SETUP_SUBMODULES -eq 'recursive') {
    cmd.exe /d /c 'git submodule update --init --recursive 2>&1'
    $code = $LASTEXITCODE
} elseif ($env:BOT_CODE_SETUP_SUBMODULES -eq 'top-level') {
    cmd.exe /d /c 'git submodule update --init 2>&1'
    $code = $LASTEXITCODE
}
if ($code -ne 0) {
    "Submodule checkout failed with code $code."
}
if ($env:BOT_CODE_SETUP_SCRIPT) {
    cmd.exe /d /s /c '"%BOT_CODE_SETUP_SCRIPT%" 2>&1'
    $code = $LASTEXITCODE
}
Set-Content -Encoding ascii -Path (Join-Path $dir 'receipt.tmp') -Value $code
Move-Item -Force (Join-Path $dir 'receipt.tmp') (Join-Path $dir 'receipt')
$lock.Dispose()
exit $code
