# Outlook PST bridge

This bridge gives Hermes controlled access to classic Outlook mail and calendar
data on Windows. It uses the signed-in user's Outlook COM/MAPI profile, so it
must run in that user's interactive desktop session.

## Security model

- The listener defaults to `127.0.0.1:8794`.
- Every API request requires a random token in `X-Hermes-Outlook-Token`.
- Drafting, sending, and calendar changes require `confirmMutation=true`.
- For access from another machine, use a private network such as Tailscale and
  restrict the Windows Firewall rule to the specific client IP.
- Do not expose the bridge through a public Funnel or bind it to every adapter.

## Setup

1. Put a random token in
   `%LOCALAPPDATA%\HermesOutlookBridge\token.txt` on the Outlook computer.
2. Copy `outlook_bridge.ps1` there and start it from the signed-in Outlook
   user's desktop with `start-bridge.cmd` or `launch-bridge-hidden.vbs`.
3. If Hermes runs elsewhere, set `HERMES_OUTLOOK_BRIDGE_HOST` on the Outlook
   computer to its private-network IP. Reserve the matching URL prefix with
   `netsh http add urlacl` and allow TCP 8794 only from the Hermes computer.
4. Put the same token in
   `%LOCALAPPDATA%\hermes\outlook-bridge-token` on the Hermes computer.
5. Set `HERMES_OUTLOOK_BRIDGE_URL` there, for example
   `http://100.x.y.z:8794`, and test:

   ```powershell
   .\outlook_client.ps1 -Action status
   ```

Read actions can run immediately. Before any mutation, show the exact proposed
change to the user and obtain explicit approval; only then pass
`-ConfirmMutation`.
