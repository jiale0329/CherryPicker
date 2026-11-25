<#
  Phase 0: verify merge strategy + the shape of the commit that actually lands
  on the target branch. This decides how the cherry-pick engine must work.
  Read-only.
#>
$ErrorActionPreference = 'Continue'

$cfg = @{}
Get-Content (Join-Path $PSScriptRoot '..\.env.local') |
    Where-Object { $_ -match '^\s*[^#].*=' } |
    ForEach-Object { $k, $v = $_ -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$h = @{ Authorization = 'Basic ' + [Convert]::ToBase64String(
        [Text.Encoding]::ASCII.GetBytes(':' + $cfg['ADO_PAT'])) }
$root = $cfg['ADO_ORG_URL'] + '/' + $cfg['ADO_PROJECT'] + '/_apis/git/repositories/'

function Try-Get($url) { try { Invoke-RestMethod $url -Headers $h } catch { $null } }

# Sample across every repo/branch pair that has data.
$sample = Import-Csv (Join-Path $PSScriptRoot 'survey-prs.csv') |
          Group-Object Repo | ForEach-Object { $_.Group | Get-Random -Count ([Math]::Min(12, $_.Count)) }

$out = foreach ($r in $sample) {
    $d = Try-Get ($root + $r.Repo + '/pullrequests/' + $r.PR + '?api-version=7.1')
    if (-not $d) { continue }
    $c = Try-Get ($root + $r.Repo + '/pullrequests/' + $r.PR + '/commits?api-version=7.1')
    [pscustomobject]@{
        Repo          = $r.Repo
        PR            = $r.PR
        SquashFlag    = [string]$d.completionOptions.squashMerge
        MergeStrategy = [string]$d.completionOptions.mergeStrategy
        SrcCommits    = if ($c) { $c.count } else { 'ERR' }
        LastMerge     = if ($d.lastMergeCommit.commitId) { $d.lastMergeCommit.commitId.Substring(0, 10) } else { '' }
        MergeParents  = if ($d.lastMergeCommit.parents) { $d.lastMergeCommit.parents.Count } else { '?' }
    }
}

Write-Host ''
Write-Host 'PER-PR COMPLETION DETAIL' -ForegroundColor Cyan
Write-Host ('{0,-28} {1,-8} {2,-7} {3,-14} {4,-11} {5}' -f 'REPO', 'PR', 'SQUASH', 'STRATEGY', 'SRCCOMMITS', 'LASTMERGE')
Write-Host ('-' * 95)
foreach ($o in $out) {
    Write-Host ('{0,-28} {1,-8} {2,-7} {3,-14} {4,-11} {5}' -f `
        $o.Repo, $o.PR, $o.SquashFlag, $o.MergeStrategy, $o.SrcCommits, $o.LastMerge)
}

Write-Host ''
Write-Host 'DISTRIBUTION' -ForegroundColor Cyan
Write-Host '  squashMerge flag:'
$out | Group-Object SquashFlag | ForEach-Object { '    {0,-10} {1}' -f ($_.Name -replace '^$', '(absent)'), $_.Count }
Write-Host '  mergeStrategy field:'
$out | Group-Object MergeStrategy | ForEach-Object { '    {0,-14} {1}' -f ($_.Name -replace '^$', '(absent)'), $_.Count }
Write-Host '  source-branch commit count:'
$out | Group-Object SrcCommits | Sort-Object Name | ForEach-Object { '    {0,-4} commits  {1} PRs' -f $_.Name, $_.Count }
Write-Host ('  PRs where lastMergeCommit is known: {0}/{1}' -f ($out | Where-Object LastMerge).Count, $out.Count)
