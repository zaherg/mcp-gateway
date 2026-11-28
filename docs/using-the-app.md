# Using the app

## The window

The sidebar has three tabs: **Overview**, **Settings** and **Logs**.
The page heading shows the tab title and, once the configuration has loaded, **Start gateway** or **Stop gateway**.
**Overview** shows a gateway status pill next to **Servers** with **Gateway running** or **Gateway stopped** and the configured `<address>:<port>`.
When the build supports updates, **Updates** appears above the sidebar footer as a quiet single-line button while idle and shows short status text when an update is active or needs attention.
Clicking it opens the **Updates** dialog, except when an update is ready (`Update ready` / `Restart to install`), when clicking it restarts to install directly.
The sidebar footer names the network of the saved address.
macOS remembers the window's size and position automatically between launches.

## Saving changes and drafts

Structured edits save immediately:

- Switches, server toggles, **Generate secure token**, server creation or edits and server deletion save right away.
- Text fields in **Settings** (**Interface / address**, **Port**, **Allowed client ranges**, **Global bearer token**) save when you leave the field or press `Return`.

Draft mode applies only to **Authoritative configuration** in **Settings**.
While you have unsaved raw edits there, **Start gateway**, copy buttons, server toggles, **Test connection** and import stay disabled until you save or reset them.
When a configuration error occurs, or when the configuration file changes on disk while you have unsaved raw edits, a red blocker bar appears above the workspace with a button to open **Authoritative configuration** or **Reset**.
When macOS login registration does not match the saved setting, **Retry login registration** appears under **Settings → General**.

## Keys in Keychain

While the configuration file holds keys that can move to the macOS Keychain, **Overview** shows "You have keys stored in the configuration file." with **Review keys** and a close button.
**Settings → Security** shows **Move keys to Keychain** for as long as such keys remain.
Both open the same two-step dialog; closing it changes nothing.
Step 1 lists each eligible key by name with masked bullets (`••••••••`), never its value.
A moved key shows **Stored in Keychain** instead of its value.
See [Keys in Keychain](configuration.md#keys-in-keychain).

## The menu-bar icon and menus

The menu-bar icon menu shows:

- A status line: "Gateway running — `<host>:<port>`", "Gateway stopped" or "Cleanup failed: see settings".
- **Start gateway** or **Stop gateway**.
  Both are disabled while the configuration has an error, except when a key stored in the macOS Keychain could not be read; then **Start gateway** reads it again.
- **Copy Gateway Endpoint URL** (enabled while running), which copies `http://<host>:<port>`.
- One quick-toggle item per configured server showing its status indicator (`●` mounted, `⚠` error, `○` stopped or disabled), letting you enable or disable a server directly.
- An update item when the app supports updates: **Check for Updates…**, **Update available: `<version>`**, or **Restart to Update (`<version>`)** (which restarts and installs directly when ready).
- **Open MCP Gateway** (or **Open MCP Gateway Dev** in signed test builds).
- **Quit MCP Gateway**.

The application menu bar includes:

- **MCP Gateway**: **About MCP Gateway**, **Settings…** (`Cmd+,`), **Check for Updates…** (when supported), **Hide MCP Gateway** (`Cmd+H`), **Hide Others** (`Cmd+Option+H`), **Show All** and **Quit MCP Gateway** (`Cmd+Q`).
- **Edit**: standard Undo, Redo, Cut, Copy, Paste and Select All.
- **View**: **Servers** (`Cmd+1`), **Logs** (`Cmd+2`), **Settings** (`Cmd+3`), **Raw Config** (`Cmd+4`) and **Reload Configuration** (`Cmd+R`).
- **Server**: **Add server…** (`Cmd+N`).
- **Window**: **Minimize** (`Cmd+M`) and **Close Window** (`Cmd+W`).
- **Help**: **Documentation**, **Show Configuration in Finder** and **GitHub Repository**.

When the window is closed, the app posts native macOS notifications for background startup errors, ready updates and failed menu-bar actions.

## Language

The app is available in English (United States), French (France), German (Germany) and Turkish (Turkey).
Choose one from the **Language** dropdown in **Settings → General**.
The default, **System default**, follows the first language in your macOS preferred-language list that the app has.
A regional variant without its own translation uses the same language, so Belgian French shows French (France) and Austrian German shows German.
If none of your languages is available, the app shows English.

A new choice applies right away to the window, the menu-bar icon menu and the app menu.
The dropdown is disabled while the app is busy or locked read-only.
The app stores the choice in `language.json`, next to `mcp.json`.
If that file is unreadable or holds an unknown language, the app uses the system language.

Only the app's own interface is translated, and some newly added controls still appear in English across locales.
Messages from the gateway, your servers and the logs stay in their original language, and so does this guide.
Translations are not yet reviewed by native speakers, so some wording may read oddly.

## Closing and quitting

`Cmd+W` closes the window and leaves the gateway running.
`Cmd+Q` (or **Quit MCP Gateway** from the app menu or menu-bar icon) stops the gateway and the backends it started, then quits.
When you have unsaved edits in **Authoritative configuration**, macOS shows a native confirmation dialog asking whether to quit and discard them.

## Starting automatically

**Launch app at login** (in **Settings → General**) is off by default.
When it is on, the app starts in the background, and you open the window from the menu-bar icon.
Background launches stay hidden even when release notes are pending; those notes appear the next time you open the app in the foreground.
If a configuration or operational error occurs during a background start, the app posts a native macOS notification instead of opening the window.
**Settings → General** shows the registration macOS has in effect: "macOS login item: Enabled", "Disabled" or "Unsupported", along with **Retry login registration** when it does not match the saved setting.
The setting above that line is a request; the status line is what macOS reports.

**Start gateway when the app opens** begins listening automatically, independently of login startup.

## Logs

The **Logs** tab shows local backend diagnostics kept in memory only and cleared when you quit.
Logs automatically redact authorization headers, API key headers, JSON secret fields, sensitive URL query parameters, common token prefixes and configured server secrets (8 or more characters) with `[REDACTED]`.
Raw stdio `stderr` output is suppressed by default, recording a suppression notice instead.
Because backend output can still include note content or other unrecognized private data, treat logs as sensitive.

The single-row toolbar provides:

- Level filter, Server filter and Search input (`Cmd+F` focuses and selects the search box).
- **Follow Tail** (on by default), which scrolls to new entries automatically, pauses when you scroll up and resumes when you scroll back to the bottom.
- **Clear logs** (clearing the list does not fix the failure behind an entry).
- A **`?`** info button that shows the sensitive-data warning and retention limits (500 entries, 2 MiB total, 16 KiB per entry, with oversized entries marked `truncated`).

Entries display as single-line rows with timestamp, color-coded level pill, server name (or `App`), message and a per-row copy button.
The tab says when earlier entries were removed by retention limits.
If reading the logs fails, the tab shows an error and retries every 2 seconds; the error clears after the next successful read.

Refused requests are not logged.
Only backend activity appears there, so a `401` or `403` has to be read from the client's own logs.

## Automatic updates

The app updates itself with the built-in Electrobun updater.
It reads the fixed feed `https://github.com/zaherg/mcp-gateway/releases/latest/download`.
Only signed stable builds can update.
Unsupported development builds hide **Updates** in the sidebar and never contact the feed.

Automatic checks and downloads are on by default.
The first check runs about 10 seconds after launch, then once a day.
A failed check or download is retried about once an hour.
You can turn this off by choosing **Updates** in the sidebar to open the **Updates** dialog.
The app stores that choice in `updates.json`, next to `mcp.json`.
If saving the choice fails, the app shows an error, keeps the previous setting and records the cause in **Logs**.
The app offers a release only when its version is higher than the installed one.

Opening the **Updates** dialog while idle automatically runs a check.
You can also check by hand in **Updates**, or from the menu bar and app menu.
During a download, **Updates** shows a progress bar with percentage and bytes downloaded.
Choose **Install and Relaunch** to download (if needed) and restart to install; once ready, clicking **Update ready** in the sidebar or **Restart to Update** in the menu-bar icon menu also restarts directly.
Before applying an update, the app verifies the v2 update manifest metadata when present and checks that the staged app bundle's code signature is valid and its Apple `TeamIdentifier` matches the installed app.
Restarting stops the gateway and discards unsaved edits in **Authoritative configuration** after asking in a native confirmation dialog.
If the handoff fails, the gateway stays stopped; quit and reopen the app to try again.
After an update, the next foreground start shows that version's release notes, taken from `CHANGELOG.md`.
Dismissing the notes leaves the window open and records the version in `seen-version.json`, next to `mcp.json`.
Closing the window without dismissing the notes leaves them pending, so a later foreground start opens them again.

`0.3.2` is the first release that can update itself.
`0.3.0` cannot update, so install the `0.3.2` or later DMG by hand.
A local rehearsal updated a signed test build that was not notarized.
It used a loopback feed that redirected to an HTTPS test feed; see [UPDATE-TESTING.md](../UPDATE-TESTING.md).
Updating from one published GitHub release to the next has not been tested yet.
