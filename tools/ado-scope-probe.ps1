<#
  Phase 0 probe narrowed to the agreed scope: 4 repositories x 6 release branches.
  Read-only. Credentials come from .env.local, never from the command line.
#>
[CmdletBinding()]
param(
    [string]$Step = 'matrix',
    [string]$Repo,
    [string]$Branch,
    [int]$Sample = 15
)

$ErrorActionPreference = 'Stop'

$envFile = Join-Path $PSScriptRoot '..\.env.local' | Resolve-Path
$cfg = @{}
Get-Content $envFile | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2
    $cfg[$k.Trim()] = $v.Trim()
}
$orgUrl = $cfg['ADO_ORG_URL'].TrimEnd('/')
$project = $cfg['ADO_PROJECT']
$authHeader = @{
    Authorization = 'Basic ' + [Convert]::ToBase64String(
        [Text.Encoding]::ASCII.GetBytes(":$($cfg['ADO_PAT'])"))
}

$REPOS = @('core-sqldatabase', 'core-consolidated-database', 'core-application', 'mms-wip-service')
$BRANCHES = @(
    'release/26.2.1.PRE', 'release/26.2.1.0',
    'release/26.5.1.PRE', 'release/26.5.1.0',
    'release/26.8.1.PRE', 'release/26.8.1.0'
)

function Invoke-Ado {
    param([string]$Path, [hashtable]$Query = @{})
    $q = @('api-version=7.1')
    foreach ($k in $Query.Keys) { $q += "$k=$([Uri]::EscapeDataString([string]$Query[$k]))" }
    Invoke-RestMethod -Uri ("$orgUrl/$Path" + '?' + ($q -join '&')) -Headers $authHeader -Method Get
}

# ---------------------------------------------------------------- branch matrix
if ($Step -eq 'matrix') {
    Write-Host "`n=== Branch existence matrix ===" -ForegroundColor Cyan
    $rows = foreach ($rn in $REPOS) {
        $r = (Invoke-Ado "$project/_apis/git/repositories/$rn")
        $refs = (Invoke-Ado "$project/_apis/git/repositories/$($r.id)/refs" @{ filter = 'heads/release/26.' }).value
        $have = $refs | ForEach-Object { $_.name -replace '^refs/heads/', '' }
        $row = [ordered]@{ Repo = $rn; SizeMB = [math]::Round($r.size / 1MB, 1) }
        foreach ($b in $BRANCHES) {
            $row[($b -replace '^release/', '')] = if ($have -contains $b) { 'YES' } else { '-' }
        }
        [pscustomobject]$row
    }
    $rows | Format-Table -AutoSize
}

# ------------------------------------------------- completed PRs + merge strategy
if ($Step -eq 'prs') {
    Write-Host "`n=== Completed PRs: $Repo -> $Branch ===" -ForegroundColor Cyan
    $prs = (Invoke-Ado "$project/_apis/git/repositories/$Repo/pullrequests" @{
            'searchCriteria.status'          = 'completed'
            'searchCriteria.targetRefName'   = "refs/heads/$Branch"
            '$top'                           = $Sample
        }).value

    if (-not $prs) { Write-Host 'No completed PRs returned.' -ForegroundColor Yellow; return }

    $rows = foreach ($pr in $prs) {
        $d = Invoke-Ado "$project/_apis/git/repositories/$Repo/pullrequests/$($pr.pullRequestId)"
        $wi = (Invoke-Ado "$project/_apis/git/repositories/$Repo/pullrequests/$($pr.pullRequestId)/workitems").count
        $commits = (Invoke-Ado "$project/_apis/git/repositories/$Repo/pullrequests/$($pr.pullRequestId)/commits").count
        [pscustomobject]@{
            PR       = $d.pullRequestId
            Strategy = if ($d.completionOptions.squashMerge) { 'squash' }
                       elseif ($d.completionOptions.mergeStrategy) { $d.completionOptions.mergeStrategy }
                       else { '(default)' }
            Commits  = $commits
            WI       = $wi
            Source   = (($d.sourceRefName -replace '^refs/heads/', '') -replace '(.{28}).+', '$1~')
            Closed   = if ($d.closedDate) { ([datetime]$d.closedDate).ToString('yyyy-MM-dd') } else { '-' }
        }
    }
    $rows | Format-Table -AutoSize
    Write-Host '--- strategy distribution ---'
    $rows | Group-Object Strategy | Select-Object Count, Name | Format-Table -AutoSize
    Write-Host "PRs with linked work items: $(($rows | Where-Object WI -gt 0).Count) / $($rows.Count)"
    Write-Host "Source branch prefixes:"
    $rows | ForEach-Object { ($_.Source -split '/')[0] } | Group-Object |
        Sort-Object Count -Desc | Select-Object Count, Name | Format-Table -AutoSize
}
