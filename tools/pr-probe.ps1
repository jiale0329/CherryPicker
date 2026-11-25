<#
  Phase 0: inspect completed pull requests on a given repo + target branch.
  Answers: merge strategy, commit counts, work item linkage, source branch naming.
  Read-only.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Repo,
    [Parameter(Mandatory)][string]$Branch,
    [int]$Sample = 15
)
$ErrorActionPreference = 'Stop'

$cfg = @{}
Get-Content (Join-Path $PSScriptRoot '..\.env.local') |
    Where-Object { $_ -match '^\s*[^#].*=' } |
    ForEach-Object { $k, $v = $_ -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }

$h = @{ Authorization = 'Basic ' + [Convert]::ToBase64String(
        [Text.Encoding]::ASCII.GetBytes(':' + $cfg['ADO_PAT'])) }
$prBase = $cfg['ADO_ORG_URL'] + '/' + $cfg['ADO_PROJECT'] + '/_apis/git/repositories/' + $Repo

function Get-Ado([string]$suffix) {
    $sep = if ($suffix -like '*?*') { '&' } else { '?' }
    Invoke-RestMethod ($prBase + $suffix + $sep + 'api-version=7.1') -Headers $h
}

$list = Get-Ado ('/pullrequests?searchCriteria.status=completed' +
                 '&searchCriteria.targetRefName=refs/heads/' + [Uri]::EscapeDataString($Branch) +
                 '&$top=' + $Sample)

Write-Host "Repo   : $Repo"
Write-Host "Branch : $Branch"
Write-Host "Sampled: $($list.count)"
if (-not $list.count) { Write-Host 'No completed PRs.' -ForegroundColor Yellow; exit 0 }

$rows = foreach ($pr in $list.value) {
    $id = $pr.pullRequestId
    $d = Get-Ado "/pullrequests/$id"
    $commits = Get-Ado "/pullrequests/$id/commits"
    $wi = Get-Ado "/pullrequests/$id/workitems"
    $strategy = if ($d.completionOptions.squashMerge -eq $true) { 'squash' }
                elseif ($d.completionOptions.mergeStrategy) { [string]$d.completionOptions.mergeStrategy }
                else { 'default' }
    [pscustomobject]@{
        PR       = $id
        Strategy = $strategy
        Commits  = $commits.count
        WI       = $wi.count
        Source   = ($d.sourceRefName -replace '^refs/heads/', '')
        Closed   = if ($d.closedDate) { ([datetime]$d.closedDate).ToString('yyyy-MM-dd') } else { '' }
    }
}

Write-Host ''
Write-Host ('{0,-7} {1,-9} {2,-8} {3,-4} {4,-11} {5}' -f 'PR', 'STRATEGY', 'COMMITS', 'WI', 'CLOSED', 'SOURCE BRANCH')
Write-Host ('-' * 100)
foreach ($r in $rows) {
    $src = if ($r.Source.Length -gt 45) { $r.Source.Substring(0, 45) + '~' } else { $r.Source }
    Write-Host ('{0,-7} {1,-9} {2,-8} {3,-4} {4,-11} {5}' -f $r.PR, $r.Strategy, $r.Commits, $r.WI, $r.Closed, $src)
}

Write-Host ''
Write-Host 'Strategy distribution:'
$rows | Group-Object Strategy | ForEach-Object { "  {0,-12} {1}" -f $_.Name, $_.Count }
Write-Host ("Linked work items: {0}/{1}" -f ($rows | Where-Object { $_.WI -gt 0 }).Count, $rows.Count)
Write-Host ("Multi-commit PRs : {0}/{1}" -f ($rows | Where-Object { $_.Commits -gt 1 }).Count, $rows.Count)
Write-Host 'Source branch prefixes:'
$rows | ForEach-Object { ($_.Source -split '/')[0] } | Group-Object |
    Sort-Object Count -Descending | ForEach-Object { "  {0,-18} {1}" -f $_.Name, $_.Count }
