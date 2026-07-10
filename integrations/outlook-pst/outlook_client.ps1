param(
  [Parameter(Mandatory=$true)][string]$Action,
  [string]$Query,[string]$Id,[string[]]$To,[string]$Subject,[string]$Body,
  [string]$Start,[string]$End,[string[]]$Attendees,[string]$Location,[int]$Top=10,
  [switch]$ConfirmMutation,
  [string]$BridgeUrl=$(if ($env:HERMES_OUTLOOK_BRIDGE_URL) { $env:HERMES_OUTLOOK_BRIDGE_URL } else { 'http://127.0.0.1:8794' }),
  [string]$TokenFile="$env:LOCALAPPDATA\hermes\outlook-bridge-token"
)
$ErrorActionPreference='Stop'
$token=(Get-Content -LiteralPath $TokenFile -Raw).Trim()
$payload=@{action=$Action;query=$Query;id=$Id;to=@($To);subject=$Subject;body=$Body;start=$Start;end=$End;attendees=@($Attendees);location=$Location;top=$Top;confirmMutation=[bool]$ConfirmMutation}
Invoke-RestMethod -Method Post -Uri "$BridgeUrl/api" -Headers @{'X-Hermes-Outlook-Token'=$token} -ContentType 'application/json' -Body ($payload|ConvertTo-Json -Depth 8) | ConvertTo-Json -Depth 12 -Compress
