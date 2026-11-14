# Using the app

## The window

The sidebar has three tabs: **Overview**, **Settings** and **Logs**.
The page heading shows the tab title and, once the configuration has loaded, **Start gateway** or **Stop gateway**, then **Quit MCP Gateway**.
The sidebar footer names the network of the saved address.
The icons below it open this guide, the GitHub repository and @zaherg on X in your default browser.
The page footer reads "Listener active" or "No active listener".

## Drafts and saving

Every edit is a draft until you save it.
When you have unsaved changes, the draft bar appears with **Discard** and **Save changes**.
**Discard** asks for confirmation.
Live endpoints keep using the saved configuration until you choose **Save changes**.
**Start gateway** stays disabled while a draft is open; the button says why when you hover it.
The draft bar also shows "Login registration unresolved" with **Retry login registration** when macOS login registration did not match the saved setting.

## The menu-bar icon

The icon menu shows a status line, **Open settings…**, an update item when the app supports updates, **Start gateway** or **Stop gateway**, and **Quit MCP Gateway**.
The status line reads "Gateway running", "Gateway stopped" or "Cleanup failed: see settings".
The update item reads "Check for Updates…", "Update available: <version>" or "Update ready: <version>".
**Start gateway** and **Stop gateway** are disabled while the configuration has an error.

The app menu has **Settings…** (`Cmd+,`), **Check for Updates…** when the app supports updates, and **Quit MCP Gateway** (`Cmd+Q`).
The File menu has **Close Window** (`Cmd+W`).
The Help menu has **MCP Gateway User Guide**, which opens this guide in your default browser.

## Closing and quitting

`Cmd+W` closes the window and leaves the gateway running.
`Cmd+Q` stops the gateway and the backends it started, then quits.
When you have unsaved changes or a dialog open, **Quit MCP Gateway** in the page heading first asks "Quit MCP Gateway?", because quitting discards the draft.

## Starting automatically

**Launch app at login** is off by default.
When it is on, the app starts in the background, and you open the window from the menu-bar icon.
Settings shows the registration macOS has in effect: "macOS login item: Enabled", "Disabled" or "Unsupported".
The setting above that line is a request; the status line is what macOS reports.

**Start gateway when the app opens** begins listening automatically, independently of login startup.

## Logs

The **Logs** tab shows backend output that is not redacted.
Logs are kept in memory only and are cleared when you quit.
Filter by level, by server or by search text, and empty the list with **Clear logs**.
Clearing the list does not fix the failure behind an entry.
At most 500 entries are kept, and the tab says when earlier entries were removed.
The tab warns that logs can contain credentials and note content.

Refused requests are not logged.
Only backend activity appears there, so a `401` or `403` has to be read from the client's own logs.

## Automatic updates

The app updates itself with the built-in Electrobun updater.
It reads the fixed feed `https://github.com/zaherg/mcp-gateway/releases/latest/download`.
Only signed stable builds can update.
Development builds report that updates are unsupported and never contact the feed.

Automatic checks and downloads are on by default.
The first check runs about 10 seconds after launch, then once a day.
A failed check or download is retried about once an hour.
You can turn this off in **Settings → Updates**.
The app stores that choice in `updates.json`, next to `mcp.json`.
The app offers a release only when its version is higher than the installed one.

You can also check by hand in **Settings → Updates**.
An update installs only when you choose **Restart to Update** and confirm.
This stops the gateway and discards unsaved configuration changes.
If the handoff fails, the gateway stays stopped; quit and reopen the app to try again.
The first window you open after an update shows that version's release notes, taken from `CHANGELOG.md`.
They appear once; closing them records the version in `seen-version.json`, next to `mcp.json`.

`0.3.2` is the first release that can update itself.
`0.3.0` cannot update, so install the `0.3.2` or later DMG by hand.
A local rehearsal updated a signed test build that was not notarized.
It used a loopback feed that redirected to an HTTPS test feed; see [UPDATE-TESTING.md](../UPDATE-TESTING.md).
Updating from one published GitHub release to the next has not been tested yet.
