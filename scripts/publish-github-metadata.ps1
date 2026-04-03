param(
  [Parameter(Mandatory = $true)]
  [string]$Token,
  [string]$Repo = "nei66s/chokito",
  [switch]$CreateRelease
)

$ErrorActionPreference = "Stop"

$headers = @{
  Authorization = "Bearer $Token"
  Accept = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
}

$description = "Chokito is a TypeScript local-first coding agent with permission pipeline, hooks, workflow tracking, and secure bash execution."
$homepage = "https://github.com/nei66s/chokito/tree/main"
$topics = @(
  "typescript",
  "openai",
  "ai-agent",
  "coding-agent",
  "permission-pipeline",
  "workflow",
  "hooks",
  "bash-security",
  "express",
  "postgres"
)

Write-Host "Updating About metadata for $Repo ..."
Invoke-RestMethod -Method Patch -Uri "https://api.github.com/repos/$Repo" -Headers $headers -Body (@{
  description = $description
  homepage = $homepage
} | ConvertTo-Json)

Write-Host "Updating repository topics for $Repo ..."
Invoke-RestMethod -Method Put -Uri "https://api.github.com/repos/$Repo/topics" -Headers $headers -Body (@{
  names = $topics
} | ConvertTo-Json)

if ($CreateRelease) {
  $tag = "v0.3.0-phase3"
  $releaseName = "Phase 3 - Bash Security Complete"
  $releaseNotes = @"
- Added bash AST parser and risk classifier.
- Added platform-aware sandbox adapter (bubblewrap/seatbelt with controlled fallback).
- Added sed inline edit parser + simulation preview.
- Added bash command history and replay foundation.
- Integrated bash security checks into permission pipeline and tool execution.
"@

  Write-Host "Creating release $tag for $Repo ..."
  Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$Repo/releases" -Headers $headers -Body (@{
    tag_name = $tag
    name = $releaseName
    body = $releaseNotes
    draft = $false
    prerelease = $false
  } | ConvertTo-Json)
}

Write-Host "Done. Metadata applied."
