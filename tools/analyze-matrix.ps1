<#
  Phase 0 analysis: can we build the release tracking matrix from real data
  using the hotfix/{workItemId}-{slug} convention as the correlation key?
  Pure local analysis of tools\survey-prs.csv. No network calls.
#>
$rows = Import-Csv (Join-Path $PSScriptRoot 'survey-prs.csv')

$BRANCHES = 'release/26.2.1.PRE', 'release/26.2.1.0', 'release/26.5.1.PRE',
            'release/26.5.1.0', 'release/26.8.1.PRE', 'release/26.8.1.0'

# ---- how parseable is the convention? -------------------------------------
$parsed = foreach ($r in $rows) {
    $key = if ($r.Source -match '^(?:hotfix|feature)/(\d{4,})') { $matches[1] } else { $null }
    [pscustomobject]@{
        Repo = $r.Repo; Branch = $r.Branch; PR = $r.PR
        Source = $r.Source; Key = $key; Author = $r.Author
    }
}
$withKey = $parsed | Where-Object Key
Write-Host ''
Write-Host 'CORRELATION KEY EXTRACTION' -ForegroundColor Cyan
Write-Host ("  PRs with a numeric id in the branch name: {0}/{1}" -f $withKey.Count, $parsed.Count)
Write-Host '  Unparseable samples:'
$parsed | Where-Object { -not $_.Key } | Select-Object -First 6 |
    ForEach-Object { '    {0}  {1}' -f $_.PR, $_.Source }

# ---- per repo: how many fixes span multiple release lines? -----------------
Write-Host ''
Write-Host 'FIX SPREAD PER REPO (distinct work-item keys per branch)' -ForegroundColor Cyan
$hdr = ($BRANCHES | ForEach-Object { ($_ -replace '^release/26\.', '').PadLeft(8) }) -join ''
Write-Host ('{0,-28} {1}' -f 'REPO', $hdr)
Write-Host ('-' * 90)
foreach ($repo in ($withKey | Select-Object -ExpandProperty Repo -Unique | Sort-Object)) {
    $cells = foreach ($b in $BRANCHES) {
        $n = ($withKey | Where-Object { $_.Repo -eq $repo -and $_.Branch -eq $b } |
              Select-Object -ExpandProperty Key -Unique).Count
        ([string]$n).PadLeft(8)
    }
    Write-Host ('{0,-28} {1}' -f $repo, ($cells -join ''))
}

# ---- the actual tracking matrix, sampled -----------------------------------
Write-Host ''
Write-Host 'SAMPLE TRACKING MATRIX - core-application' -ForegroundColor Cyan
Write-Host '(X = a completed PR for this work item merged into that branch)'
$repoRows = $withKey | Where-Object Repo -eq 'core-application'
$groups = $repoRows | Group-Object Key | Sort-Object { [int]$_.Name } -Descending
Write-Host ('{0,-12} {1}  {2}' -f 'WORKITEM', '2.PRE 2.0 5.PRE 5.0 8.PRE 8.0', 'SLUG')
Write-Host ('-' * 100)
foreach ($g in ($groups | Select-Object -First 25)) {
    $cells = foreach ($b in $BRANCHES) {
        if ($g.Group | Where-Object Branch -eq $b) { '  X  ' } else { '  .  ' }
    }
    $slug = (($g.Group[0].Source -split '-', 2)[1])
    if ($slug.Length -gt 40) { $slug = $slug.Substring(0, 40) + '~' }
    Write-Host ('{0,-12} {1} {2}' -f $g.Name, ($cells -join ''), $slug)
}

# ---- completeness statistics ----------------------------------------------
Write-Host ''
Write-Host 'BACKPORT COMPLETENESS (work items per repo, PRE branches only)' -ForegroundColor Cyan
$pre = 'release/26.2.1.PRE', 'release/26.5.1.PRE', 'release/26.8.1.PRE'
foreach ($repo in ($withKey | Select-Object -ExpandProperty Repo -Unique | Sort-Object)) {
    $sub = $withKey | Where-Object { $_.Repo -eq $repo -and $pre -contains $_.Branch }
    if (-not $sub) { continue }
    $byKey = $sub | Group-Object Key
    $present = ($sub | Select-Object -ExpandProperty Branch -Unique).Count
    $full = ($byKey | Where-Object { ($_.Group | Select-Object -ExpandProperty Branch -Unique).Count -eq $present }).Count
    Write-Host ('  {0,-28} {1,4} fixes, {2,4} on all {3} PRE branches, {4,4} partial' -f `
        $repo, $byKey.Count, $full, $present, ($byKey.Count - $full))
}
