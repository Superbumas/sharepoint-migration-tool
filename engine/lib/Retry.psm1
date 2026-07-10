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
