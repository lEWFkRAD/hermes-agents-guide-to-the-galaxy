param(
  [string]$ListenHost = $(if ($env:HERMES_OUTLOOK_BRIDGE_HOST) { $env:HERMES_OUTLOOK_BRIDGE_HOST } else { '127.0.0.1' }),
  [int]$Port = 8794,
  [string]$TokenFile = "$env:LOCALAPPDATA\HermesOutlookBridge\token.txt"
)

$ErrorActionPreference = 'Stop'
$logFile = "$env:LOCALAPPDATA\HermesOutlookBridge\bridge.log"
function Log($text) { "$(Get-Date -Format o) $text" | Add-Content -LiteralPath $logFile }
Log 'starting'
$token = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
if (-not $token) { throw "Missing bridge token: $TokenFile" }
Log 'token loaded'

$outlook = New-Object -ComObject Outlook.Application
Log 'Outlook COM connected'
$mapi = $outlook.GetNamespace('MAPI')
Log 'MAPI namespace connected'
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://${ListenHost}:$Port/")
$listener.Start()
Log "listening on http://${ListenHost}:$Port/"

function Json($value) { $value | ConvertTo-Json -Depth 12 -Compress }
function MailAddress($addressEntry) {
  try {
    if ($addressEntry.Type -eq 'EX') { return $addressEntry.GetExchangeUser().PrimarySmtpAddress }
    return $addressEntry.Address
  } catch { return '' }
}
function EventObject($item) {
  [ordered]@{
    id=$item.EntryID; subject=$item.Subject; start=$item.Start.ToString('o'); end=$item.End.ToString('o')
    location=$item.Location; organizer=$item.Organizer; requiredAttendees=$item.RequiredAttendees
    optionalAttendees=$item.OptionalAttendees; body=$item.Body; isRecurring=[bool]$item.IsRecurring
  }
}
function RequireMutation($body) {
  if (-not $body.confirmMutation) { throw 'Mutation blocked: explicit user approval is required.' }
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $response = $ctx.Response
  try {
    if ($ctx.Request.Headers['X-Hermes-Outlook-Token'] -ne $token) {
      $response.StatusCode = 401
      $bytes = [Text.Encoding]::UTF8.GetBytes((Json @{ok=$false;error='unauthorized'}))
    } elseif ($ctx.Request.HttpMethod -eq 'GET' -and $ctx.Request.Url.AbsolutePath -eq '/health') {
      $response.StatusCode = 200
      $bytes = [Text.Encoding]::UTF8.GetBytes((Json @{ok=$true;outlook=$true;machine=$env:COMPUTERNAME}))
    } else {
      $reader = New-Object IO.StreamReader($ctx.Request.InputStream,$ctx.Request.ContentEncoding)
      $raw = $reader.ReadToEnd(); $reader.Dispose()
      $body = if ($raw) { $raw | ConvertFrom-Json } else { [pscustomobject]@{} }
      $action = [string]$body.action
      $result = $null

      switch ($action) {
        'status' {
          $stores=@(); for($i=1;$i -le $mapi.Stores.Count;$i++){$s=$mapi.Stores.Item($i);$stores+=@{name=$s.DisplayName;path=$s.FilePath}}
          $result=@{ok=$true;machine=$env:COMPUTERNAME;user=$env:USERNAME;stores=$stores}
        }
        'mail-search' {
          $query=([string]$body.query).ToLowerInvariant(); $top=[Math]::Min([Math]::Max([int]$body.top,1),50)
          $items=$mapi.GetDefaultFolder(6).Items; $items.Sort('[ReceivedTime]',$true)
          $found=@(); $limit=[Math]::Min($items.Count,1000)
          for($i=1;$i -le $limit -and $found.Count -lt $top;$i++){
            $m=$items.Item($i); if($m.Class -ne 43){continue}
            $hay=([string]$m.Subject+' '+[string]$m.SenderName+' '+[string]$m.SenderEmailAddress+' '+[string]$m.Body).ToLowerInvariant()
            if(-not $query -or $hay.Contains($query)){$found+=@{id=$m.EntryID;subject=$m.Subject;sender=$m.SenderName;senderEmail=(MailAddress $m.Sender);received=$m.ReceivedTime.ToString('o');unread=[bool]$m.UnRead;preview=([string]$m.Body).Substring(0,[Math]::Min(500,([string]$m.Body).Length))}}
          }
          $result=@{ok=$true;messages=$found}
        }
        'mail-get' {
          $m=$mapi.GetItemFromID([string]$body.id)
          $tos=@(); foreach($r in $m.Recipients){$tos+=@{name=$r.Name;address=(MailAddress $r.AddressEntry);type=$r.Type}}
          $result=@{ok=$true;message=@{id=$m.EntryID;subject=$m.Subject;sender=$m.SenderName;senderEmail=(MailAddress $m.Sender);received=$m.ReceivedTime.ToString('o');recipients=$tos;body=$m.Body}}
        }
        'draft-create' {
          RequireMutation $body; $m=$outlook.CreateItem(0); $m.Subject=[string]$body.subject; $m.Body=[string]$body.body
          foreach($a in @($body.to)){$null=$m.Recipients.Add([string]$a)}; $null=$m.Recipients.ResolveAll(); $m.Save()
          $result=@{ok=$true;status='draft-created';id=$m.EntryID;subject=$m.Subject}
        }
        'draft-send' {
          RequireMutation $body; $m=$mapi.GetItemFromID([string]$body.id); $m.Send()
          $result=@{ok=$true;status='sent';id=[string]$body.id}
        }
        'calendar-list' {
          $start=[datetime]$body.start; $end=[datetime]$body.end; $items=$mapi.GetDefaultFolder(9).Items
          $items.IncludeRecurrences=$true; $items.Sort('[Start]'); $filter="[Start] < '$( $end.ToString('g') )' AND [End] > '$( $start.ToString('g') )'"
          $events=@(); foreach($e in @($items.Restrict($filter))){$events+=(EventObject $e);if($events.Count -ge 100){break}}
          $result=@{ok=$true;events=$events}
        }
        'calendar-create' {
          RequireMutation $body; $e=$outlook.CreateItem(1);$e.Subject=[string]$body.subject;$e.Start=[datetime]$body.start;$e.End=[datetime]$body.end;$e.Location=[string]$body.location;$e.Body=[string]$body.body
          foreach($a in @($body.attendees)){$r=$e.Recipients.Add([string]$a);$r.Type=1};$null=$e.Recipients.ResolveAll();$e.Save()
          $result=@{ok=$true;status='event-created';event=(EventObject $e)}
        }
        'calendar-update' {
          RequireMutation $body; $e=$mapi.GetItemFromID([string]$body.id)
          if($null -ne $body.subject){$e.Subject=[string]$body.subject};if($body.start){$e.Start=[datetime]$body.start};if($body.end){$e.End=[datetime]$body.end};if($null -ne $body.location){$e.Location=[string]$body.location};if($null -ne $body.body){$e.Body=[string]$body.body};$e.Save()
          $result=@{ok=$true;status='event-updated';event=(EventObject $e)}
        }
        'calendar-delete' {
          RequireMutation $body; $e=$mapi.GetItemFromID([string]$body.id);$e.Delete();$result=@{ok=$true;status='event-deleted';id=[string]$body.id}
        }
        default { throw "Unknown action: $action" }
      }
      $response.StatusCode=200; $bytes=[Text.Encoding]::UTF8.GetBytes((Json $result))
    }
  } catch {
    $response.StatusCode=500; $bytes=[Text.Encoding]::UTF8.GetBytes((Json @{ok=$false;error=$_.Exception.Message}))
  }
  $response.ContentType='application/json; charset=utf-8';$response.ContentLength64=$bytes.Length;$response.OutputStream.Write($bytes,0,$bytes.Length);$response.Close()
}
