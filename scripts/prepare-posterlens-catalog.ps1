param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '../catalog-imports/posterlens-25m'),
  [switch]$MetadataOnly,
  [ValidateRange(0,100000)][int]$Limit = 0
)

$ErrorActionPreference = 'Stop'
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
$postersRoot = Join-Path $outputRoot 'posters'
New-Item -ItemType Directory -Path $postersRoot -Force | Out-Null
if (-not ('HttpRangeZipStream' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'HttpRangeZipStream.cs') }
$utf8 = [System.Text.UTF8Encoding]::new($false)
$posterUrl = 'https://www.kaggle.com/api/v1/datasets/download/aptlin/posterlens-25m?datasetVersionNumber=2'
$movieUrl = 'https://files.grouplens.org/datasets/movielens/ml-25m.zip'
$converter = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../node_modules/ffmpeg-static/ffmpeg.exe'))

function Copy-ZipEntry($Entry, $Destination) {
  $inputStream = $Entry.Open()
  try {
    $buffer = [byte[]]::new(65536)
    [long]$total = 0
    while (($amount = $inputStream.Read($buffer, 0, [int][Math]::Min($buffer.Length, $Entry.Length - $total + 1))) -gt 0) {
      $total += $amount
      if ($total -gt $Entry.Length) { throw 'ZIP content exceeds its declared size.' }
      $Destination.Write($buffer, 0, $amount)
    }
    if ($total -ne $Entry.Length) { throw 'Interrupted ZIP entry.' }
  } finally { $inputStream.Dispose() }
}
function Read-ZipText($Archive, [string]$Name) {
  $entry = $Archive.GetEntry($Name)
  if (-not $entry -or $entry.Length -gt 20MB) { throw "Missing or oversized metadata: $Name" }
  $memory = [System.IO.MemoryStream]::new()
  try { Copy-ZipEntry $entry $memory; return [System.Text.UTF8Encoding]::new($false,$true).GetString($memory.ToArray()) }
  finally { $memory.Dispose() }
}
function Save-Progress($Progress) {
  [System.IO.File]::WriteAllText((Join-Path $outputRoot 'progress.json'), ($Progress | ConvertTo-Json -Depth 4), $utf8)
}

$metadataStream = [HttpRangeZipStream]::new($movieUrl, 1MB)
try {
  $metadataZip = [System.IO.Compression.ZipArchive]::new($metadataStream,[System.IO.Compression.ZipArchiveMode]::Read,$true)
  try {
    $moviesText = Read-ZipText $metadataZip 'ml-25m/movies.csv'
    $linksText = Read-ZipText $metadataZip 'ml-25m/links.csv'
    $licenseText = Read-ZipText $metadataZip 'ml-25m/README.txt'
  } finally { $metadataZip.Dispose() }
} finally { $metadataStream.Dispose() }
[System.IO.File]::WriteAllText((Join-Path $outputRoot 'MovieLens-README.txt'), $licenseText, $utf8)
$links = @{}
foreach ($link in ($linksText | ConvertFrom-Csv)) {
  if ($link.imdbId -match '^\d{1,10}$') { $links[$link.movieId] = ([long]$link.imdbId).ToString('D7') }
}
$yearLimit = (Get-Date).Year + 10
$skippedRows = 0
$rows = @($moviesText | ConvertFrom-Csv | ForEach-Object {
  $movie = $_; $movieTitle = [string]$movie.title; $releaseYear = ''
  if ($movieTitle -match '^(.*)\s+\((\d{4})\)$') { $movieTitle = $Matches[1]; $releaseYear = $Matches[2] }
  if ($movieTitle -match '^(.*), (The|A|An)$') { $movieTitle = $Matches[2] + ' ' + $Matches[1] }
  if (-not $movieTitle.Trim() -or $movieTitle.Length -gt 200 -or $movie.movieId -notmatch '^\d+$') { $skippedRows++ }
  else {
    if ($releaseYear -and ([int]$releaseYear -lt 1888 -or [int]$releaseYear -gt $yearLimit)) { $releaseYear = '' }
    $imdbId = $links[$movie.movieId]
    [PSCustomObject]@{
      id = 'ml_' + $movie.movieId; title = $movieTitle.Trim(); year = $releaseYear; description = ''
      poster_filename = $(if ($imdbId) { 'imdb_' + $imdbId + '.jpg' } else { '' })
      genre = $(if ($movie.genres -eq '(no genres listed)') { '' } else { $movie.genres })
    }
  }
})
if ($rows.Count -lt 60000 -or $rows.Count -gt 100000) { throw 'Unexpected MovieLens 25M catalog size.' }
[System.IO.File]::WriteAllText((Join-Path $outputRoot 'movies.csv'), (($rows | ConvertTo-Csv -NoTypeInformation) -join "`r`n") + "`r`n", $utf8)
$wanted = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
foreach ($row in $rows) { if ($row.poster_filename) { [void]$wanted.Add($row.poster_filename) } }
$provenance = @"
PosterLens 25M, version 2, by Sasha Aptlin (2021).
Dataset: https://www.kaggle.com/datasets/aptlin/posterlens-25m
Creator: https://github.com/aptlin/posterlens
Citation: Sasha Aptlin, PosterLens 25M. Kaggle, 2021, doi:10.34740/KAGGLE/DS/1321802.
Dataset license label: Data files (c) Original Authors. Poster copyright remains with its respective owners; this is not a public-domain image collection.
Movie names, genres, years, and IMDb mappings: official MovieLens 25M dataset. Keep MovieLens-README.txt for its research-use license and attribution.
The published archive uses zero-padded IMDb IDs for cover filenames. They are joined to MovieLens IDs through links.csv, NOT by equating the two ID systems.
Only referenced covers are downloaded. Research embeddings and the full ZIP are not saved. Oversized or non-JPEG images are normalized to JPEG with local FFmpeg.
Images and CSVs stay private in catalog-imports, excluded from Git and desktop packaging. No API key or runtime online movie service is used.
"@
[System.IO.File]::WriteAllText((Join-Path $outputRoot 'PROVENANCE.txt'), $provenance, $utf8)
Write-Output "Prepared $($rows.Count) movie names; $skippedRows unsupported rows skipped."
if ($MetadataOnly) { return }

$progress = [ordered]@{ state='downloading'; movies=$rows.Count; available=0; completed=0; resumed=0; converted=0; failed=0; downloadedBytes=0; failures=@(); updatedAt='' }
$posterStream = [HttpRangeZipStream]::new($posterUrl)
try {
  $archive = [System.IO.Compression.ZipArchive]::new($posterStream,[System.IO.Compression.ZipArchiveMode]::Read,$true)
  try {
    $entries = @($archive.Entries | Where-Object {
      $_.FullName -match '^covers/covers/(\d{1,10})\.jpg$' -and $wanted.Contains('imdb_' + ([long]$Matches[1]).ToString('D7') + '.jpg')
    })
    if ($entries.Count -lt 60000 -or $entries.Count -gt 65000) { throw 'Unexpected PosterLens 25M cover count.' }
    $progress.available = $entries.Count
    Write-Output "Found $($entries.Count) referenced poster images. Existing completed files will be reused."
    $lastReport = [DateTime]::UtcNow
    foreach ($entry in $entries) {
      if ($Limit -gt 0 -and $progress.completed -ge $Limit) { break }
      $digits = [System.IO.Path]::GetFileNameWithoutExtension($entry.FullName)
      $filename = 'imdb_' + ([long]$digits).ToString('D7') + '.jpg'
      $destination = Join-Path $postersRoot $filename
      $partial = $destination + '.part'
      $normalized = $destination + '.normalized.jpg'
      try {
        $existing = Get-Item -LiteralPath $destination -ErrorAction SilentlyContinue
        if ($existing -and $existing.Length -gt 3 -and $existing.Length -le 10MB) { $progress.resumed++; $progress.completed++ }
        else {
          if ($entry.Length -lt 3 -or $entry.Length -gt 100MB) { throw 'Poster is outside the bounded source-image size limit.' }
          $availableDisk = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($outputRoot)).AvailableFreeSpace
          if ($availableDisk -lt 2GB) { throw 'Less than 2 GB disk space remains; stop and resume after freeing space.' }
          $outputFile = [System.IO.File]::Create($partial)
          try { Copy-ZipEntry $entry $outputFile } finally { $outputFile.Dispose() }
          if ((Get-Item -LiteralPath $partial).Length -ne $entry.Length) { throw 'Interrupted poster download.' }
          $header = [System.IO.File]::OpenRead($partial)
          try {
            $signature = [byte[]]::new(12)
            if ($header.Read($signature,0,12) -lt 12) { throw 'Incomplete source image.' }
            $magic = [System.Convert]::ToHexString($signature)
            $jpeg = $magic.StartsWith('FFD8FF')
            if ($magic -notmatch '^(FFD8FF|89504E470D0A1A0A|474946383[79]61|52494646[0-9A-F]{8}57454250|424D|49492A00|4D4D002A)') {
              throw 'Source file is not a supported poster image.'
            }
          } finally { $header.Dispose() }
          if (-not $jpeg -or $entry.Length -gt 10MB) {
            if (-not (Test-Path -LiteralPath $converter)) { throw 'Run npm ci to install the local image conversion engine.' }
            $engineLog = $destination + '.conversion.log'
            & $converter -hide_banner -loglevel error -nostdin -y -protocol_whitelist file,pipe -f image2pipe -i $partial -vf "scale=w='min(1000,iw)':h=-2" -frames:v 1 -q:v 3 $normalized 2> $engineLog
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $normalized) -or (Get-Item -LiteralPath $normalized).Length -gt 10MB) { throw "Could not normalize this poster; see $engineLog" }
            Move-Item -LiteralPath $normalized -Destination $destination -Force
            Remove-Item -LiteralPath $partial
            $progress.converted++
          } else { Move-Item -LiteralPath $partial -Destination $destination -Force }
          $progress.completed++
        }
      } catch {
        $progress.failed++
        if ($progress.failures.Count -lt 30) { $progress.failures += "$filename : $($_.Exception.Message)" }
        if ($_.Exception.Message -like '*disk space*') { throw }
      }
      if (([DateTime]::UtcNow - $lastReport).TotalSeconds -ge 10) {
        $progress.downloadedBytes = $posterStream.DownloadedBytes
        $progress.updatedAt = [DateTime]::UtcNow.ToString('o')
        Save-Progress $progress
        Write-Output "Posters: $($progress.completed)/$($progress.available); failed: $($progress.failed); downloaded: $([Math]::Round($posterStream.DownloadedBytes / 1GB,2)) GiB"
        $lastReport = [DateTime]::UtcNow
      }
    }
    $progress.state = $(if ($Limit -gt 0 -and $progress.completed -lt $entries.Count) {'sample'} elseif ($progress.failed) {'completed-with-errors'} else {'complete'})
  } finally { $archive.Dispose() }
} finally {
  $progress.downloadedBytes = $posterStream.DownloadedBytes
  $progress.updatedAt = [DateTime]::UtcNow.ToString('o')
  Save-Progress $progress
  $posterStream.Dispose()
}
Write-Output ($progress | ConvertTo-Json -Depth 3)
