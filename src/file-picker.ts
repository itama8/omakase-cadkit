// The browser cannot provide an absolute local folder path. Use the OS picker;
// pass paths as arguments/environment values, never as executable script text.
import { execFile } from "node:child_process";
import path from "node:path";

// A never-shown Form has no topmost desktop window to own the picker. Show a
// transparent owner first so the native dialog appears above the browser, without
// adding a visible window or taskbar button. Keep it alive until the dialog closes.
const windowsPickerOwner = `
$owner = New-Object System.Windows.Forms.Form
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.TopMost = $true
`;

function dialog(cmd: string, args: string[], folder: string, cancelExit = false): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      windowsHide: true, timeout: 300_000, encoding: "utf8",
      env: { ...process.env, OMAKASE_PICKER_FOLDER: folder },
    }, (err, stdout, stderr) => {
      if (!err) resolve(stdout.trim() || null);
      else if ((cancelExit && err.code === 1) || (process.platform === "darwin" && stderr.includes("(-128)"))) resolve(null);
      else reject(err);
    });
  });
}

export async function pickFolder(folder: string): Promise<string | null> {
  if (process.platform === "win32") {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose a drawing folder'
$dialog.SelectedPath = $env:OMAKASE_PICKER_FOLDER
$dialog.ShowNewFolderButton = $false
${windowsPickerOwner}
try {
  $owner.Show()
  $owner.Activate()
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) }
} finally { $dialog.Dispose(); $owner.Dispose() }
`;
    const exe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return dialog(exe, ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], folder);
  }
  if (process.platform === "darwin") {
    return dialog("/usr/bin/osascript", ["-e", `on run argv
try
return POSIX path of (choose folder with prompt "Choose a drawing folder" default location (POSIX file (item 1 of argv)))
on error number -128
return ""
end try
end run`, folder], folder);
  }
  try {
    return await dialog("zenity", ["--file-selection", "--directory", "--title=Choose a drawing folder", `--filename=${folder}${path.sep}`], folder, true);
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
    try {
      return await dialog("kdialog", ["--getexistingdirectory", folder, "--title", "Choose a drawing folder"], folder, true);
    } catch (fallback: any) {
      if (fallback.code === "ENOENT") throw new Error("A folder picker needs Zenity or KDialog on this Linux desktop.");
      throw fallback;
    }
  }
}

/** The system "open file" dialog limited to drawings; null when the person cancels. */
export async function pickDrawing(folder: string): Promise<string | null> {
  if (process.platform === "win32") {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Open a drawing'
$dialog.Filter = 'Drawings (*.dwg;*.dxf)|*.dwg;*.dxf|All files (*.*)|*.*'
$dialog.InitialDirectory = $env:OMAKASE_PICKER_FOLDER
$dialog.CheckFileExists = $true
${windowsPickerOwner}
try {
  $owner.Show()
  $owner.Activate()
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.FileName) }
} finally { $dialog.Dispose(); $owner.Dispose() }
`;
    const exe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return dialog(exe, ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], folder);
  }
  if (process.platform === "darwin") {
    return dialog("/usr/bin/osascript", ["-e", `on run argv
try
return POSIX path of (choose file with prompt "Open a drawing" of type {"dwg", "dxf", "com.autodesk.dwg", "com.autodesk.dxf"} default location (POSIX file (item 1 of argv)))
on error number -128
return ""
end try
end run`, folder], folder);
  }
  try {
    return await dialog("zenity", ["--file-selection", "--title=Open a drawing", "--file-filter=Drawings | *.dwg *.DWG *.dxf *.DXF", "--file-filter=All files | *", `--filename=${folder}${path.sep}`], folder, true);
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
    try {
      return await dialog("kdialog", ["--getopenfilename", folder, "Drawings (*.dwg *.DWG *.dxf *.DXF)", "--title", "Open a drawing"], folder, true);
    } catch (fallback: any) {
      if (fallback.code === "ENOENT") throw new Error("A file picker needs Zenity or KDialog on this Linux desktop.");
      throw fallback;
    }
  }
}
