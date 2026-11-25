<#
  Phase 0 survey: completed-PR volume and conventions across the agreed
  4 repositories x 6 release branches. Read-only.
#>
$ErrorActionPreference = 'Continue'

$cfg = @{}
Get-Content (Join-Path $PSScriptRoot '..\.env.local') |
    Where-Object { $_ -match '^\s*[^#].*=' } |
    ForEach-Object { $k, $v = $_ -split '=', 2; $cfg[$k.Trim()] = $v.Trim() }
$h = @{ Authorization = 'Basic ' + [Convert]::ToBase64String(
        [Text.Encoding]::ASCII.GetBytes(':' + $cfg['ADO_PAT'])) }
$root = $cfg['ADO_ORG_URL'] + '/' + $cfg['ADO_PROJECT'] + '/_apis/git/repositories/'

$REPOS = 'core-sqldatabase', 'core-consolidated-database', 'core-application', 'mms-wip-service'
$BRANCHES = 'release/26.2.1.PRE', 'release/26.2.1.0', 'release/26.5.1.PRE',
            'release/26.5.1.0', 'release/26.8.1.PRE', 'release/26.8.1.0'

function Try-Get($url) { try { Invoke-RestMethod $url -Headers $h } catch { $null } }

$all = @()
Write-Host ''
Write-Host 'COMPLETED PR COUNT  (".." = branch absent)' -ForegroundColor Cyan
$hdr = ($BRANCHES | ForEach-Object { ($_ -replace '^release/26\.', '').PadLeft(8) }) -join ''
Write-Host ('{0,-28} {1}' -f 'REPO', $hdr)
Write-Host ('-' * 90)

foreach ($rn in $REPOS) {
    $repo = Try-Get ($root + $rn + '?api-version=7.1')
    $refs = (Try-Get ($root + $repo.id + '/refs?filter=heads/release/26.&api-version=7.1')).value |
            ForEach-Object { $_.name -replace '^refs/heads/', '' }
    $cells = foreach ($br in $BRANCHES) {
        if ($refs -notcontains $br) { '      ..' ; continue }
        $prs = Try-Get ($root + $rn + '/pullrequests?searchCriteria.status=completed' +
                        '&searchCriteria.targetRefName=refs/heads/' + $br + '&$top=200&api-version=7.1')
        $n = if ($prs) { $prs.count } else { 'ERR' }
        foreach ($p in $prs.value) {
            $all += [pscustomobject]@{
                Repo = $rn; Branch = $br; PR = $p.pullRequestId
                Source = ($p.sourceRefName -replace '^refs/heads/', '')
                Author = $p.createdBy.displayName
                Closed = $p.closedDate
            }
        }
        ([string]$n).PadLeft(8)
    }
    Write-Host ('{0,-28} {1}' -f $rn, ($cells -join ''))
}

Write-Host ''
Write-Host 'SOURCE BRANCH PREFIX CONVENTION (all sampled PRs)' -ForegroundColor Cyan
$all | ForEach-Object { ($_.Source -split '/')[0] } | Group-Object |
    Sort-Object Count -Descending | Select-Object -First 12 |
    ForEach-Object { '  {0,-24} {1}' -f $_.Name, $_.Count }

Write-Host ''
Write-Host 'TOP AUTHORS' -ForegroundColor Cyan
$all | Group-Object Author | Sort-Object Count -Descending | Select-Object -First 8 |
    ForEach-Object { '  {0,-32} {1}' -f $_.Name, $_.Count }

Write-Host ''
Write-Host ('Total completed PRs collected: {0}' -f $all.Count)
$all | Export-Csv (Join-Path $PSScriptRoot 'survey-prs.csv') -NoTypeInformation -Encoding UTF8
Write-Host ('Saved detail to tools\survey-prs.csv')
