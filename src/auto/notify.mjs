// A desktop toast when the runner disables itself — Phase 4.3.
//
// WHY THIS IS BEST-EFFORT AND SAYS SO. The STOP file is the brake and
// INBOX.md is the record; both are durable and both are checked by code. A
// toast is neither. It exists because the runner is a scheduled task that fires
// while nobody is looking, and a brake nobody notices for eleven hours has
// stopped the machine without telling anyone — but if the notification API is
// missing, or the shell is locked down, or the user is on a different OS, that
// must degrade to "no toast" and never to "no stop".
//
// So: every failure here is swallowed, the call never blocks, and the return
// value says what happened for a caller that wants to log it. Nothing in this
// file is allowed to throw.
//
// NO DEPENDENCY, DELIBERATELY. The usual answer is the BurntToast module, which
// means installing something onto the user's machine for a cosmetic feature.
// This uses the WinRT ToastNotificationManager that ships with Windows 10,
// through the PowerShell AppID that is already registered — no install, and no
// new thing to remove later.
import { spawn } from "node:child_process"

// PowerShell's own registered AppID. A toast needs one that exists in the
// start menu or Windows silently drops it; borrowing PowerShell's is the only
// way to raise one without registering an application first.
const APP_ID =
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"

// XML-escape, because the title and body carry text that may have come off a
// third-party page. A toast is a render target like any other.
const xml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

function script(title, body) {
  return [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] > $null",
    "$x = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$x.LoadXml('<toast><visual><binding template="ToastText02"><text id="1">${xml(title)}</text><text id="2">${xml(body)}</text></binding></visual></toast>')`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
  ].join("; ")
}

/**
 * Raise a desktop notification. Returns synchronously; the shell runs detached.
 *
 * @returns {{attempted: boolean, reason: string|null}}
 */
export function toast(
  title,
  body,
  { platform = process.platform, env = process.env } = {},
) {
  // Two opt-outs, and the second one is the one that matters. AJ_NO_TOAST is
  // for CI and for a user who does not want them. NODE_TEST_CONTEXT is set by
  // `node --test` in every test process, and it is here because relying on a
  // suite to remember an env var is how a green run ends with forty
  // notifications on somebody's desktop.
  if (env.AJ_NO_TOAST) return { attempted: false, reason: "AJ_NO_TOAST is set" }
  if (env.NODE_TEST_CONTEXT)
    return { attempted: false, reason: "running under node --test" }
  if (platform !== "win32")
    return { attempted: false, reason: `no toast backend for ${platform}` }
  try {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script(title, body)],
      { detached: true, stdio: "ignore", windowsHide: true },
    )
    // Detach: the notification must outlive the process that raised it, and a
    // runner exiting must never wait on a cosmetic child.
    child.on("error", () => {})
    child.unref()
    return { attempted: true, reason: null }
  } catch (e) {
    return { attempted: false, reason: String(e?.message ?? e) }
  }
}
