<#
  qsketch helper for Windows (Windows PowerShell 5.1 or PowerShell 7).

  Serves the screenshot editor on 127.0.0.1 and receives the annotated images.
  Talks to the Claude Code mod through stdout, one JSON object per line:
    {"type":"ready","port":N,"url":"..."}    listening
    {"type":"opened","browser":"edge"}        an editor window was opened
    {"type":"attached","id":...,"meta":{...}} an image was attached
    {"type":"log","message":"..."}            something worth a debug line
    {"type":"exit","reason":"idle"}           stopping on its own

  GET api/waiting lists the attached images the mod has not marked done;
  POST api/done {"ids":[...]} marks them sent or dropped.

  Every URL lives under a random token, so other local pages cannot reach it.
#>
param(
    [Parameter(Mandatory = $true)][string]$Token,
    [Parameter(Mandatory = $true)][string]$EditorDir,
    [Parameter(Mandatory = $true)][string]$StoreDir,
    [int]$KeepDays = 7,
    [int]$IdleMinutes = 30,
    [ValidateSet('auto', 'edge', 'chrome', 'default')][string]$Browser = 'auto',
    [switch]$Open
)

$ErrorActionPreference = 'Stop'

$Utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8

$MaxBody = 64MB
$MaxMeta = 1MB
$ContentTypes = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.ico'  = 'image/x-icon'
    '.json' = 'application/json; charset=utf-8'
}
$StatusText = @{
    200 = 'OK'; 301 = 'Moved Permanently'; 400 = 'Bad Request'; 403 = 'Forbidden'
    404 = 'Not Found'; 405 = 'Method Not Allowed'; 413 = 'Payload Too Large'
    500 = 'Internal Server Error'
}

function Write-Event([string]$Json) {
    try {
        [Console]::Out.WriteLine($Json)
        [Console]::Out.Flush()
    } catch {
        # The mod is gone; nobody is left to serve.
        exit 0
    }
}

function ConvertTo-JsonString([string]$Text) {
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    foreach ($ch in $Text.ToCharArray()) {
        $code = [int]$ch
        if ($ch -eq [char]'"') { [void]$builder.Append('\"') }
        elseif ($ch -eq [char]'\') { [void]$builder.Append('\\') }
        elseif ($code -lt 0x20) { [void]$builder.Append(('\u{0:x4}' -f $code)) }
        else { [void]$builder.Append($ch) }
    }
    [void]$builder.Append('"')
    $builder.ToString()
}

function Write-Log([string]$Message) {
    Write-Event ('{"type":"log","message":' + (ConvertTo-JsonString $Message) + '}')
}

function New-RandomHex([int]$Bytes) {
    $buffer = New-Object byte[] $Bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    -join ($buffer | ForEach-Object { $_.ToString('x2') })
}

function Remove-OldFiles {
    if ($KeepDays -le 0) { return }
    $limit = (Get-Date).AddDays(-$KeepDays)
    Get-ChildItem -LiteralPath $StoreDir -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'annotation-*' -and $_.LastWriteTime -lt $limit } |
        ForEach-Object {
            try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop } catch { }
        }
}

function Get-AppPath([string]$Exe, [string[]]$Fallbacks) {
    foreach ($root in 'HKCU:\SOFTWARE', 'HKLM:\SOFTWARE', 'HKLM:\SOFTWARE\WOW6432Node') {
        $key = "$root\Microsoft\Windows\CurrentVersion\App Paths\$Exe"
        try {
            $value = (Get-ItemProperty -LiteralPath $key -ErrorAction Stop).'(default)'
            if ($value) {
                $value = $value.Trim().Trim('"')
                if (Test-Path -LiteralPath $value -PathType Leaf) { return $value }
            }
        } catch { }
    }
    foreach ($path in $Fallbacks) {
        if ($path -and (Test-Path -LiteralPath $path -PathType Leaf)) { return $path }
    }
    return $null
}

function Start-Detached([string]$CommandLine) {
    # Created by WMI, the process is no child of this one: when the session
    # stops this helper, a browser it started keeps running.
    try {
        $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
            -Arguments @{ CommandLine = $CommandLine } -ErrorAction Stop
        return ($result.ReturnValue -eq 0)
    } catch {
        return $false
    }
}

function Open-Editor {
    $exe = $null
    $choice = 'default'
    if ($Browser -eq 'auto' -or $Browser -eq 'edge') {
        $exe = Get-AppPath 'msedge.exe' @(
            (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
            (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'))
        if ($exe) { $choice = 'edge' }
    }
    if (-not $exe -and ($Browser -eq 'auto' -or $Browser -eq 'chrome')) {
        $exe = Get-AppPath 'chrome.exe' @(
            (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
            (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'))
        if ($exe) { $choice = 'chrome' }
    }
    if ($exe) {
        $arguments = "--app=$Url --window-size=1400,900"
        if (-not (Start-Detached "`"$exe`" $arguments")) {
            Start-Process -FilePath $exe -ArgumentList $arguments
        }
    } else {
        if (-not (Start-Detached "explorer.exe `"$Url`"")) { Start-Process $Url }
    }
    Write-Event ('{"type":"opened","browser":"' + $choice + '"}')
}

function Open-StoreFolder {
    if (-not (Start-Detached "explorer.exe `"$StoreDir`"")) {
        Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$StoreDir`""
    }
}

function Read-Request([System.Net.Sockets.NetworkStream]$Stream) {
    $buffer = New-Object byte[] 65536
    $head = New-Object System.IO.MemoryStream
    $end = -1
    $text = ''
    while ($end -lt 0) {
        $count = $Stream.Read($buffer, 0, $buffer.Length)
        if ($count -le 0) { return $null }
        $head.Write($buffer, 0, $count)
        $text = [System.Text.Encoding]::ASCII.GetString($head.GetBuffer(), 0, [int]$head.Length)
        $end = $text.IndexOf("`r`n`r`n")
        if ($end -lt 0 -and $head.Length -gt 65536) { throw 'request head too large' }
    }
    $lines = $text.Substring(0, $end).Split([string[]]@("`r`n"), [StringSplitOptions]::None)
    $first = $lines[0].Split(' ')
    if ($first.Length -lt 2) { throw 'bad request line' }
    $headers = @{}
    for ($i = 1; $i -lt $lines.Length; $i++) {
        $colon = $lines[$i].IndexOf(':')
        if ($colon -gt 0) {
            $name = $lines[$i].Substring(0, $colon).Trim().ToLowerInvariant()
            $headers[$name] = $lines[$i].Substring($colon + 1).Trim()
        }
    }
    $length = 0
    if ($headers.ContainsKey('content-length')) { $length = [int]$headers['content-length'] }
    if ($length -lt 0 -or $length -gt $MaxBody) { throw 'body too large' }
    $body = New-Object byte[] $length
    $start = $end + 4
    $have = [Math]::Min([int]$head.Length - $start, $length)
    if ($have -gt 0) { [Array]::Copy($head.GetBuffer(), $start, $body, 0, $have) } else { $have = 0 }
    while ($have -lt $length) {
        $count = $Stream.Read($body, $have, $length - $have)
        if ($count -le 0) { throw 'connection closed early' }
        $have += $count
    }
    return @{
        Method  = $first[0].ToUpperInvariant()
        Target  = $first[1]
        Headers = $headers
        Body    = $body
    }
}

function Send-Response($Stream, [int]$Status, [string]$ContentType, [byte[]]$Body, [string[]]$Extra) {
    $reason = $StatusText[$Status]
    if (-not $reason) { $reason = 'Status' }
    $head = "HTTP/1.1 $Status $reason`r`n" +
        "Content-Type: $ContentType`r`n" +
        "Content-Length: $($Body.Length)`r`n" +
        "Cache-Control: no-store`r`n" +
        "X-Content-Type-Options: nosniff`r`n" +
        "Connection: close`r`n"
    foreach ($line in $Extra) { if ($line) { $head += "$line`r`n" } }
    $head += "`r`n"
    $headBytes = [System.Text.Encoding]::ASCII.GetBytes($head)
    $Stream.Write($headBytes, 0, $headBytes.Length)
    if ($Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
    $Stream.Flush()
}

function Send-Json($Stream, [int]$Status, [string]$Json) {
    Send-Response $Stream $Status 'application/json; charset=utf-8' ($Utf8.GetBytes($Json)) @()
}

function Send-Static($Stream, [string]$Path) {
    $relative = $Path
    if ($relative -eq '') { $relative = 'index.html' }
    if ($relative -notmatch '^[A-Za-z0-9_\-./]+$' -or $relative.Contains('..')) {
        Send-Json $Stream 404 '{"ok":false,"error":"not found"}'
        return
    }
    $file = Join-Path $EditorDir ($relative -replace '/', '\')
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        Send-Json $Stream 404 '{"ok":false,"error":"not found"}'
        return
    }
    $extension = [System.IO.Path]::GetExtension($file).ToLowerInvariant()
    $type = $ContentTypes[$extension]
    if (-not $type) { $type = 'application/octet-stream' }
    $extra = @()
    if ($extension -eq '.html') {
        $extra = @("Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'")
    }
    Send-Response $Stream 200 $type ([System.IO.File]::ReadAllBytes($file)) $extra
}

function Save-Attachment([byte[]]$Body) {
    # The body is one line of JSON metadata, a newline, then the PNG's bytes.
    $newline = [Array]::IndexOf($Body, [byte]10)
    if ($newline -lt 2 -or $newline -gt $MaxMeta) { throw 'missing metadata' }
    $meta = $Utf8.GetString($Body, 0, $newline).Trim()
    if (-not ($meta.StartsWith('{') -and $meta.EndsWith('}'))) { throw 'metadata is not a JSON object' }
    $null = ConvertFrom-Json -InputObject $meta
    $pngStart = $newline + 1
    $pngLength = $Body.Length - $pngStart
    $signature = @(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
    if ($pngLength -lt 64) { throw 'image is missing' }
    for ($i = 0; $i -lt 8; $i++) {
        if ($Body[$pngStart + $i] -ne $signature[$i]) { throw 'image is not a PNG' }
    }
    $id = 'annotation-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + (New-RandomHex 2)
    $png = Join-Path $StoreDir "$id.png"
    $json = Join-Path $StoreDir "$id.json"
    $file = [System.IO.File]::Open($png, [System.IO.FileMode]::CreateNew)
    try { $file.Write($Body, $pngStart, $pngLength) } finally { $file.Dispose() }
    [System.IO.File]::WriteAllText($json, $meta, $Utf8)
    $item = '{"id":"' + $id + '","png":' + (ConvertTo-JsonString $png) + ',"json":' + (ConvertTo-JsonString $json) + ',"meta":' + $meta + '}'
    [void]$Attachments.Add([pscustomobject]@{ Id = $id; Json = $item; Done = $false })
    Write-Event ('{"type":"attached",' + $item.Substring(1))
    return '{"ok":true,"id":"' + $id + '","path":' + (ConvertTo-JsonString $png) + '}'
}

# What this helper saved and the mod has not yet sent or dropped: the mod asks
# for it when a prompt goes out, in case a stdout report never reached it.
function Get-Waiting {
    $items = @($Attachments | Where-Object { -not $_.Done } | ForEach-Object { $_.Json })
    return '{"ok":true,"items":[' + ($items -join ',') + ']}'
}

function Set-Done([byte[]]$Body) {
    $ids = @((ConvertFrom-Json -InputObject $Utf8.GetString($Body)).ids)
    foreach ($attachment in $Attachments) {
        if ($ids -contains $attachment.Id) { $attachment.Done = $true }
    }
    return '{"ok":true}'
}

function Invoke-Request($Stream, $Request) {
    $target = $Request.Target
    $query = $target.IndexOf('?')
    if ($query -ge 0) { $target = $target.Substring(0, $query) }

    $hostHeader = $Request.Headers['host']
    if ($hostHeader -ne "127.0.0.1:$Port" -and $hostHeader -ne "localhost:$Port") {
        Send-Json $Stream 403 '{"ok":false,"error":"wrong host"}'
        return
    }
    if ($target -eq "/$Token") {
        Send-Response $Stream 301 'text/plain; charset=utf-8' ($Utf8.GetBytes('Moved')) @("Location: /$Token/")
        return
    }
    $prefix = "/$Token/"
    if (-not $target.StartsWith($prefix)) {
        Send-Json $Stream 404 '{"ok":false,"error":"not found"}'
        return
    }
    $path = $target.Substring($prefix.Length)

    if ($path.StartsWith('api/')) {
        $origin = $Request.Headers['origin']
        if ($origin -and $origin -ne "http://127.0.0.1:$Port" -and $origin -ne "http://localhost:$Port") {
            Send-Json $Stream 403 '{"ok":false,"error":"wrong origin"}'
            return
        }
        switch ($path) {
            'api/ping' {
                Send-Json $Stream 200 '{"ok":true}'
            }
            'api/attach' {
                if ($Request.Method -ne 'POST') { Send-Json $Stream 405 '{"ok":false}'; return }
                Send-Json $Stream 200 (Save-Attachment $Request.Body)
            }
            'api/waiting' {
                Send-Json $Stream 200 (Get-Waiting)
            }
            'api/done' {
                if ($Request.Method -ne 'POST') { Send-Json $Stream 405 '{"ok":false}'; return }
                Send-Json $Stream 200 (Set-Done $Request.Body)
            }
            'api/open' {
                if ($Request.Method -ne 'POST') { Send-Json $Stream 405 '{"ok":false}'; return }
                Open-Editor
                Send-Json $Stream 200 '{"ok":true}'
            }
            'api/reveal' {
                if ($Request.Method -ne 'POST') { Send-Json $Stream 405 '{"ok":false}'; return }
                Open-StoreFolder
                Send-Json $Stream 200 '{"ok":true}'
            }
            default {
                Send-Json $Stream 404 '{"ok":false,"error":"not found"}'
            }
        }
        return
    }
    if ($Request.Method -ne 'GET' -and $Request.Method -ne 'HEAD') {
        Send-Json $Stream 405 '{"ok":false}'
        return
    }
    Send-Static $Stream $path
}

New-Item -ItemType Directory -Force -Path $StoreDir | Out-Null
Remove-OldFiles
$Attachments = New-Object System.Collections.ArrayList

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$Port = $listener.LocalEndpoint.Port
$Url = "http://127.0.0.1:$Port/$Token/"
Write-Event ('{"type":"ready","port":' + $Port + ',"url":' + (ConvertTo-JsonString $Url) +
    ',"store":' + (ConvertTo-JsonString $StoreDir) + '}')
if ($Open) { Open-Editor }

$lastActivity = [DateTime]::UtcNow
try {
    while ($true) {
        if (-not $listener.Pending()) {
            if ($IdleMinutes -gt 0 -and ([DateTime]::UtcNow - $lastActivity).TotalMinutes -ge $IdleMinutes) {
                Write-Event '{"type":"exit","reason":"idle"}'
                break
            }
            Start-Sleep -Milliseconds 40
            continue
        }
        $client = $listener.AcceptTcpClient()
        $lastActivity = [DateTime]::UtcNow
        try {
            $client.ReceiveTimeout = 15000
            $client.SendTimeout = 15000
            $stream = $client.GetStream()
            $request = Read-Request $stream
            if ($request) {
                try {
                    Invoke-Request $stream $request
                } catch {
                    Write-Log ("request failed: " + $_.Exception.Message)
                    try { Send-Json $stream 400 ('{"ok":false,"error":' + (ConvertTo-JsonString $_.Exception.Message) + '}') } catch { }
                }
            }
        } catch {
            Write-Log ("connection failed: " + $_.Exception.Message)
        } finally {
            $client.Close()
        }
    }
} finally {
    $listener.Stop()
}
