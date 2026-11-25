<#
  Phase 0 read-only connectivity probe for the Release Backport Manager.
  Reads credentials from .env.local so the PAT never appears in a command line.
  Performs GET requests only.
#>
[CmdletBinding()]
param(
    [string]$Step = 'all',
    [string]$Repo,
    [string]$TargetBranch,
    [int]$Top = 20
)

$ErrorActionPreference = 'Stop'

# --- load .env.local -------------------------------------------------------
$envFile = Join-Path $PSScriptRoot '..\.env.local' | Resolve-Path
$cfg = @{}
Get-Content $envFile | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2
    $cfg[$k.Trim()] = $v.Trim()
}

$orgUrl  = $cfg['ADO_ORG_URL'].TrimEnd('/')
$project = $cfg['ADO_PROJECT']
$pat     = $cfg['ADO_PAT']
$apiVer  = '7.1'

$authHeader = @{
    Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(":$pat"))
}

function Invoke-Ado {
    param([string]$Path, [hashtable]$Query = @{})
    $q = @("api-version=$apiVer")
    foreach ($k in $Query.Keys) {
        $q += "$k=$([Uri]::EscapeDataString([string]$Query[$k]))"
    }
    $uri = "$orgUrl/$Path" + '?' + ($q -join '&')
    try {
        Invoke-RestMethod -Uri $uri -Headers $authHeader -Method Get -ErrorAction Stop
    }
    catch {
        Write-Host "  REQUEST FAILED: $Path" -ForegroundColor Red
        Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
        if ($_.Exception.Response) {
            Write-Host "  HTTP $([int]$_.Exception.Response.StatusCode)" -ForegroundColor Red
        }
        throw
    }
}

function Write-Section($text) {
    Write-Host ''
    Write-Host "=== $text ===" -ForegroundColor Cyan
}

# --- step: identity + TLS --------------------------------------------------
if ($Step -in 'all', 'auth') {
    Write-Section 'TLS + authentication'
    Write-Host "Org:     $orgUrl"
    Write-Host "Project: $project"
    Write-Host "TLS verification: enabled (NODE_TLS_REJECT_UNAUTHORIZED not used)"
    $proj = Invoke-Ado "_apis/projects/$project"
    Write-Host "Project resolved: $($proj.name)  id=$($proj.id)  state=$($proj.state)" -ForegroundColor Green
}

# --- step: repositories ----------------------------------------------------
if ($Step -in 'all', 'repos') {
    Write-Section 'Repositories'
    $repos = (Invoke-Ado "$project/_apis/git/repositories").value
    Write-Host "Count: $($repos.Count)"
    $repos | Sort-Object -Property @{ e = { $_.size } } -Descending |
        Select-Object -First 40 @{n = 'name'; e = { $_.name } },
                                 @{n = 'defaultBranch'; e = { ($_.defaultBranch -replace '^refs/heads/', '') } },
                                 @{n = 'sizeMB'; e = { [math]::Round($_.size / 1MB, 1) } },
                                 @{n = 'disabled'; e = { $_.isDisabled } } |
        Format-Table -AutoSize
}

# --- step: release branches ------------------------------------------------
if ($Step -in 'all', 'branches') {
    Write-Section 'Release branches'
    $repos = (Invoke-Ado "$project/_apis/git/repositories").value
    $targets = if ($Repo) { $repos | Where-Object name -eq $Repo } else { $repos }
    foreach ($r in $targets) {
        if ($r.isDisabled) { continue }
        try {
            $refs = (Invoke-Ado "$project/_apis/git/repositories/$($r.id)/refs" @{ filter = 'heads/release' }).value
        }
        catch { continue }
        if ($refs.Count -gt 0) {
            $names = ($refs | ForEach-Object { $_.name -replace '^refs/heads/', '' } | Sort-Object) -join ', '
            Write-Host ("{0,-38} {1}" -f $r.name, $names)
        }
    }
}

# --- step: completed PRs + merge strategy ----------------------------------
if ($Step -in 'all', 'prs') {
    if (-not $Repo) { Write-Host 'Pass -Repo to probe pull requests.' -ForegroundColor Yellow; return }
    Write-Section "Completed PRs in $Repo -> $TargetBranch"
    $q = @{
        'searchCriteria.status' = 'completed'
        '$top'                  = $Top
    }
    if ($TargetBranch) { $q['searchCriteria.targetRefName'] = "refs/heads/$TargetBranch" }
    $prs = (Invoke-Ado "$project/_apis/git/repositories/$Repo/pullrequests" $q).value
    Write-Host "Returned: $($prs.Count)"

    $rows = foreach ($pr in $prs) {
        $d = Invoke-Ado "$project/_apis/git/repositories/$Repo/pullrequests/$($pr.pullRequestId)"
        [pscustomobject]@{
            PR            = $d.pullRequestId
            MergeStrategy = if ($d.completionOptions.squashMerge) { 'squash' }
                            elseif ($d.completionOptions.mergeStrategy) { $d.completionOptions.mergeStrategy }
                            else { '(none/default)' }
            SourceBranch  = ($d.sourceRefName -replace '^refs/heads/', '')
            LastMerge     = if ($d.lastMergeCommit.commitId) { $d.lastMergeCommit.commitId.Substring(0, 8) } else { '-' }
            WorkItems     = (Invoke-Ado "$project/_apis/git/repositories/$Repo/pullrequests/$($d.pullRequestId)/workitems").count
            Title         = if ($d.title.Length -gt 50) { $d.title.Substring(0, 50) } else { $d.title }
        }
    }
    $rows | Format-Table -AutoSize

    Write-Section 'Merge strategy distribution'
    $rows | Group-Object MergeStrategy | Select-Object Count, Name | Format-Table -AutoSize
    Write-Section 'Work item linkage'
    $linked = ($rows | Where-Object { $_.WorkItems -gt 0 }).Count
    Write-Host "PRs with >=1 linked work item: $linked / $($rows.Count)"
}
