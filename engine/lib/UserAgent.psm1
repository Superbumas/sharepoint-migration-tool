#Requires -Version 7.0

# Traffic decoration for SharePoint Online / Microsoft Graph throttling.
# Microsoft asks migration tools to identify themselves with a User-Agent of
# the form "NONISV|<Company>|<App>/<Version>" (or "ISV|..." for a registered
# ISV): decorated traffic is prioritised over undecorated traffic when a
# tenant is being throttled, and lets Microsoft support see which tool sent
# a request. See "Avoid getting throttled or blocked in SharePoint Online" ->
# "How to decorate your http traffic".
#
# Three different HTTP stacks run inside one engine process, and each needs
# its own hook (all verified with a System.Net.Http diagnostic listener
# against a real tenant):
#   - PnP Core / PnP Framework (sign-in, Invoke-PnPGraphMethod, every Graph
#     call PnP makes): reads the SharePointPnPUserAgent environment variable.
#   - CSOM (Get-PnPFolderItem, Copy-PnPFile, Set-PnPListItem ... anything on
#     <tenant>.sharepoint.com): ignores that variable and always sends
#     "NONISV|SharePointPnP|PnPPS/<ver>", so Register-PnPUserAgent overrides
#     it per request through the ClientContext's ExecutingWebRequest event.
#   - Our own Invoke-WebRequest / Invoke-RestMethod calls (OneDrive uploads,
#     Azure Blob): default to "Mozilla/5.0 ... PowerShell/7.x". The modules
#     that make them (BlobTarget, OneDriveTarget) set a module-scoped
#     $PSDefaultParameterValues; the global one set below only covers calls
#     made directly from a script.
# Every lane runs in its own runspace, so each lane calls
# Initialize-MigrationUserAgent itself and registers each connection it opens.

$script:Version = '1.0.0'
try {
    $pkg = Get-Content -Path (Join-Path $PSScriptRoot '../../package.json') -Raw -ErrorAction Stop | ConvertFrom-Json
    if ($pkg.version) { $script:Version = [string]$pkg.version }
} catch {}
$script:UserAgent = "NONISV|Knowall|SharePointMigrationTool/$($script:Version)"

function Get-MigrationUserAgent { $script:UserAgent }

# Call once per runspace, before PnP.PowerShell is first used (the env var
# is read when PnP builds its HTTP clients).
function Initialize-MigrationUserAgent {
    $env:SharePointPnPUserAgent = $script:UserAgent
    # PnP.PowerShell checks GitHub for a newer version on first connect - an
    # extra outbound call per lane that a migration job never needs.
    $env:PNPPOWERSHELL_UPDATECHECK = 'Off'
    # ...and reports usage telemetry to Application Insights - undecorated
    # traffic to a third host, and nothing the migration needs.
    $env:PNPPOWERSHELL_DISABLETELEMETRY = 'true'
    $global:PSDefaultParameterValues['Invoke-WebRequest:UserAgent'] = $script:UserAgent
    $global:PSDefaultParameterValues['Invoke-RestMethod:UserAgent'] = $script:UserAgent
}

if (-not ('MigrationUserAgentHook' -as [type])) {
    # try/catch: lanes import this module concurrently, and the type is
    # process-wide - a lane losing that race just finds it already defined.
    try {
    # Reflection-only so this compiles without referencing the CSOM assembly,
    # which PnP.PowerShell loads into its own AssemblyLoadContext.
    Add-Type -TypeDefinition @'
using System;
using System.Reflection;
public class MigrationUserAgentHook {
    readonly string ua;
    MigrationUserAgentHook(string u) { ua = u; }
    public static void Attach(object clientContext, string ua) {
        var ev = clientContext.GetType().GetEvent("ExecutingWebRequest");
        if (ev == null) return;
        var mi = typeof(MigrationUserAgentHook).GetMethod("OnExecuting", BindingFlags.Instance | BindingFlags.NonPublic);
        ev.AddEventHandler(clientContext, Delegate.CreateDelegate(ev.EventHandlerType, new MigrationUserAgentHook(ua), mi));
    }
    void OnExecuting(object sender, EventArgs e) {
        try {
            var exec = e.GetType().GetProperty("WebRequestExecutor").GetValue(e);
            var req = exec.GetType().GetProperty("WebRequest").GetValue(exec) as System.Net.HttpWebRequest;
            if (req != null) req.UserAgent = ua;
        } catch { }
    }
}
'@
    } catch {}
}

# Registers the override on a connection's CSOM ClientContext. Safe to call
# more than once per connection only if you accept duplicate handlers - call
# it right after each Connect-PnPOnline. Never throws: a failure here only
# means CSOM traffic keeps PnP's own (still NONISV-decorated) agent.
function Register-PnPUserAgent {
    param([Parameter(Mandatory, ValueFromPipeline)]$Connection)
    try {
        if ($Connection.Context) { [MigrationUserAgentHook]::Attach($Connection.Context, $script:UserAgent) }
    } catch {}
    return $Connection
}

Export-ModuleMember -Function Get-MigrationUserAgent, Initialize-MigrationUserAgent, Register-PnPUserAgent
