param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '../catalog-imports'),
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$catalogDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$catalogFile = Join-Path $catalogDirectory 'movies.csv'
if ((Test-Path -LiteralPath $catalogFile) -and -not $Force) {
  throw 'movies.csv already exists. Choose another OutputDirectory or use -Force to regenerate it.'
}
New-Item -ItemType Directory -Path $catalogDirectory -Force | Out-Null
$archiveFile = Join-Path $catalogDirectory 'ml-latest-small.zip'
$sourceUrl = 'https://files.grouplens.org/datasets/movielens/ml-latest-small.zip'
Invoke-WebRequest -Uri $sourceUrl -OutFile $archiveFile -TimeoutSec 45

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($archiveFile)
try {
  # Read only the two expected entries; no archive-controlled paths are extracted.
  $movieEntry = $archive.GetEntry('ml-latest-small/movies.csv')
  $readmeEntry = $archive.GetEntry('ml-latest-small/README.txt')
  if (-not $movieEntry -or -not $readmeEntry -or $movieEntry.Length -gt 20MB) {
    throw 'The MovieLens archive does not contain the expected bounded movie catalog.'
  }
  $movieReader = [System.IO.StreamReader]::new($movieEntry.Open(), [System.Text.Encoding]::UTF8)
  try { $sourceCsv = $movieReader.ReadToEnd() } finally { $movieReader.Dispose() }
  $licenseReader = [System.IO.StreamReader]::new($readmeEntry.Open(), [System.Text.Encoding]::UTF8)
  try { $sourceReadme = $licenseReader.ReadToEnd() } finally { $licenseReader.Dispose() }
} finally { $archive.Dispose() }

$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Join-Path $catalogDirectory 'MovieLens-README.txt'), $sourceReadme, $utf8)
$currentYear = (Get-Date).Year
$skipped = 0
$catalogRows = @($sourceCsv | ConvertFrom-Csv | ForEach-Object {
  $movie = $_
  $movieTitle = [string]$movie.title
  $releaseYear = ''
  if ($movieTitle -match '^(.*)\s+\((\d{4})\)$') {
    $movieTitle = $Matches[1]
    $releaseYear = $Matches[2]
  }
  # MovieLens often puts English articles last; make normal title searches work.
  if ($movieTitle -match '^(.*), (The|A|An)$') { $movieTitle = $Matches[2] + ' ' + $Matches[1] }
  if (-not $movieTitle.Trim() -or $movieTitle.Length -gt 200 -or
      ($releaseYear -and ([int]$releaseYear -lt 1888 -or [int]$releaseYear -gt $currentYear + 10))) {
    $skipped++
  } else {
    [PSCustomObject]@{
      id = 'ml_' + $movie.movieId
      title = $movieTitle.Trim()
      year = $releaseYear
      description = ''
      poster_filename = 'ml_' + $movie.movieId + '.jpg'
      genre = $(if ($movie.genres -eq '(no genres listed)') { '' } else { $movie.genres })
    }
  }
})
if ($catalogRows.Count -eq 0 -or $catalogRows.Count -gt 50000) { throw 'The catalog size is outside the supported limits for this app version.' }
$csvLines = @($catalogRows | ConvertTo-Csv -NoTypeInformation)
[System.IO.File]::WriteAllText($catalogFile, ($csvLines -join "`r`n") + "`r`n", $utf8)
$notes = @"
Prepared from the official GroupLens MovieLens small dataset.
Source: $sourceUrl
Prepared: $((Get-Date).ToString('yyyy-MM-dd'))
Movies: $($catalogRows.Count); skipped unsupported entries: $skipped.

This CSV contains movie titles, years, and genres. It does not include posters or plots.
Import movies.csv through Library settings > Offline catalog.
To attach a local poster, use the image filename listed in poster_filename (for example ml_1.jpg), then import that image through the same catalog screen.
Keep MovieLens-README.txt with the data for its license and attribution requirements.
MovieLens is supplied under research-use terms; commercial or revenue-bearing use requires permission from GroupLens. See the complete original license before reusing the data.
The original dataset and this generated CSV stay in the gitignored catalog-imports folder; they are not bundled with the app or uploaded to GitHub.
"@
[System.IO.File]::WriteAllText((Join-Path $catalogDirectory 'README.txt'), $notes, $utf8)
Write-Output "Prepared $($catalogRows.Count) movies: $catalogFile"
Write-Output 'Posters are separate local images; the starter dataset includes names, years, and genres only.'
