#Requires -Version 7.0

# Best-effort HTTP status extraction across the exception shapes PnP.PowerShell /
# CSOM / Graph calls can throw. PnP wraps the underlying HTTP failure in different
# ways depending on cmdlet and transport, so we check several known shapes and
# fall back to scraping the status code out of the message text.
function Get-HttpStatusCode {
    param($Exception)

    if (-not $Exception) { return $null }

    if ($Exception.PSObject.Properties.Name -contains 'Response' -and $Exception.Response) {
        try {
            $code = [int]$Exception.Response.StatusCode
            if ($code -gt 0) { return $code }
        } catch {}
    }
    if ($Exception.PSObject.Properties.Name -contains 'StatusCode' -and $Exception.StatusCode) {
        try { return [int]$Exception.StatusCode } catch {}
    }

    if ($Exception.Message -match '\((\d{3})\)' ) { return [int]$Matches[1] }
    if ($Exception.Message -match '\b(429|503|502|504|403|401|404|423)\b') { return [int]$Matches[1] }

    # Invoke-PnPGraphMethod's own error text names the HTTP reason phrase, not
    # the numeric code (".../root/children failed with status code Conflict:
    # Name already exists") - none of the numeric fallbacks above ever match
    # it, so every PnP-Graph caller here (409-is-fine folder/file creation,
    # 404-means-no-drive, Invoke-WithRetry's retry check) silently treated
    # every Graph failure as unrecognized and re-threw or gave up instead of
    # handling it. Observed live: OneDrive-target jobs failing hard on the
    # very first pre-existing folder (e.g. a user's OneDrive already has a
    # "Documents" folder from Known Folder Move) instead of treating the 409
    # as "already there".
    if ($Exception.Message -match 'status code (\w+)') {
        $reasonPhrase = $Matches[1]
        $code = switch ($reasonPhrase) {
            'BadRequest'          { 400; break }
            'Unauthorized'        { 401; break }
            'Forbidden'           { 403; break }
            'NotFound'            { 404; break }
            'Conflict'            { 409; break }
            'PreconditionFailed'  { 412; break }
            'Locked'              { 423; break }
            'TooManyRequests'     { 429; break }
            'InternalServerError' { 500; break }
            'NotImplemented'      { 501; break }
            'BadGateway'          { 502; break }
            'ServiceUnavailable'  { 503; break }
            'GatewayTimeout'      { 504; break }
            default               { $null }
        }
        if ($code) { return $code }
    }

    return $null
}

function Get-RetryAfterMs {
    param($Exception)

    try {
        $headers = $null
        if ($Exception.PSObject.Properties.Name -contains 'Response' -and $Exception.Response) {
            $headers = $Exception.Response.Headers
        }
        if ($headers) {
            $val = $null
            if ($headers.TryGetValues('Retry-After', [ref]$val)) {
                $seconds = [double]($val | Select-Object -First 1)
                return [int]($seconds * 1000)
            }
        }
    } catch {}
    return $null
}

function Test-IsRetryableStatus {
    param([int]$StatusCode, [string]$Message)
    if ($StatusCode -in 429, 503, 502, 504) { return $true }
    if ($Message -match 'timed? ?out|temporarily unavailable|connection reset|socket exception|throttl') { return $true }
    # Azure Storage rejects a block/blob whose bytes were corrupted in
    # transit with a 400 Md5Mismatch (the request's Content-MD5 header
    # didn't match what the service received) - safe to retry, and this
    # string never appears in PnP/Graph errors so it can't misfire there.
    if ($Message -match 'Md5Mismatch') { return $true }
    # PnP/CSOM concurrency hiccups observed when several lanes fire their
    # first Add-PnPFile simultaneously (cold shared state): the upload often
    # commits and the cmdlet then throws loading the result. Both signatures
    # are transient - a retry (or the caller's landed-anyway check) resolves
    # them; neither string occurs in genuine permission/validation errors.
    if ($Message -match 'Cannot access a closed file') { return $true }
    if ($Message -match "has not been initialized\. It has not been requested") { return $true }
    # Same class of client-side PnP hiccup as the two above (no HTTP status,
    # no Graph URL in the message - it never left the SDK): a Nullable<T>
    # unboxed without a HasValue check while PnP parses a call's own result.
    # Observed live on a OneDrive-target upload (createUploadSession or a
    # chunk PUT) that otherwise had nothing distinguishing it from the many
    # adjacent files that succeeded - a retry is expected to just work.
    if ($Message -match 'Nullable object must have a value') { return $true }
    # OneDrive/Graph 409 on createUploadSession when a session for the same
    # path is already open - normally another lane/process finishing (or a
    # stale session expiring) within a few backoff attempts, and Graph's own
    # message literally says "try to save again." Genuinely never reflects a
    # bad file - always retryable.
    if ($Message -match 'currently being uploaded') { return $true }
    # A filesystem source's SMB session is shared across every concurrently-
    # running engine process on this machine (see Invoke-MigrationJob.ps1's
    # preflight comment and fsSource.js's identical note) - another job
    # reconnecting to the same share can transiently deny an in-flight
    # OpenRead here even though the file and the account's permissions are
    # both fine. Observed live: three jobs against different subfolders of
    # the same \\server\share all hit a burst of "Access to the path ...
    # is denied" right as one of them resumed and reconnected.
    if ($Message -match "Access to the path '.*' is denied") { return $true }
    # .NET's own low-level JSON reader message ("Failure to parse near
    # offset N. Expected an ASCII digit.") - not a PowerShell type-conversion
    # error, and not anything a specific file's metadata could deterministically
    # trigger every time. Points at a truncated/corrupted HTTP response body
    # (throttling, a dropped connection mid-stream) rather than a permanently
    # malformed one - a retry gets a fresh response. Observed live: a 27,000+
    # file OneDrive target-index prefetch died on this, with no HTTP status in
    # the exception at all, aborting the whole bulk scan after 23,391 files.
    if ($Message -match 'Failure to parse near offset|Expected an ASCII digit') { return $true }
    return $false
}

# Executes $Action, retrying on throttling/transient failures with the Graph/SPO
# Retry-After header when present, else exponential backoff with jitter. Every
# retry attempt invokes $OnRetry so the caller can emit an item_retry event -
# retries are never silent, per the audit requirement.
function Invoke-WithRetry {
    param(
        [Parameter(Mandatory)][scriptblock]$Action,
        [int]$MaxAttempts = 5,
        [scriptblock]$OnRetry
    )
    $attempt = 0
    while ($true) {
        $attempt++
        try {
            return & $Action
        } catch {
            $statusCode = Get-HttpStatusCode -Exception $_.Exception
            # Invoke-WebRequest/Invoke-RestMethod (used by the Blob target)
            # put the response body - where Azure's <Code>Md5Mismatch</Code>
            # actually lives - into $_.ErrorDetails.Message, not
            # $_.Exception.Message. PnP/CSOM errors never populate
            # ErrorDetails, so folding it in here is safe for both targets.
            $msgText = $_.Exception.Message
            if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $msgText = "$msgText $($_.ErrorDetails.Message)" }
            $retryable = Test-IsRetryableStatus -StatusCode $statusCode -Message $msgText
            if (-not $retryable -or $attempt -ge $MaxAttempts) { throw }

            $retryAfterMs = Get-RetryAfterMs -Exception $_.Exception
            $reason = if ($statusCode -in 429, 503) { 'throttled' } else { 'transient_error' }
            if (-not $retryAfterMs) {
                $base = [Math]::Min(30000, [Math]::Pow(2, $attempt) * 500)
                $jitter = Get-Random -Minimum 0 -Maximum ([Math]::Max(1, [int]($base * 0.3)))
                $retryAfterMs = [int]$base + $jitter
            }

            if ($OnRetry) {
                & $OnRetry $attempt $retryAfterMs $reason $statusCode $msgText
            }
            Start-Sleep -Milliseconds $retryAfterMs
        }
    }
}

Export-ModuleMember -Function Get-HttpStatusCode, Get-RetryAfterMs, Test-IsRetryableStatus, Invoke-WithRetry
