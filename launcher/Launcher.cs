// omakase-cadkit.exe: starts the viewer with no console window. The Start menu entry, "Open
// with" on a drawing and a double-click in the download folder all land here. It runs the
// bundled Node on scripts/launch.mjs with the same arguments as launch.cmd, then exits; the
// viewer server keeps running in the background. Failures are shown in a message box.

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class Launcher
{
	[DllImport("user32.dll", CharSet = CharSet.Unicode)]
	static extern int MessageBoxW(IntPtr owner, string text, string caption, uint type);

	const uint IconError = 0x10;

	static int Main(string[] args)
	{
		var root = AppDomain.CurrentDomain.BaseDirectory;
		var node = Path.Combine(root, ".tools", "node", "bin", "node.exe");
		var launch = Path.Combine(root, "scripts", "launch.mjs");
		if (!File.Exists(node) || !File.Exists(launch))
			return Fail("This omakase-cadkit folder is incomplete (" + (File.Exists(node) ? launch : node) + " is missing). Reinstall it or extract the download again.", "");

		var line = new StringBuilder(Quote(launch));
		foreach (var a in args) line.Append(' ').Append(Quote(a));
		var psi = new ProcessStartInfo(node, line.ToString())
		{
			UseShellExecute = false,
			CreateNoWindow = true,
			WorkingDirectory = root,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			StandardOutputEncoding = Encoding.UTF8,
			StandardErrorEncoding = Encoding.UTF8,
		};
		var output = new StringBuilder();
		Process p;
		try
		{
			p = new Process { StartInfo = psi };
			DataReceivedEventHandler collect = (s, e) => { if (e.Data != null) lock (output) output.AppendLine(e.Data); };
			p.OutputDataReceived += collect;
			p.ErrorDataReceived += collect;
			p.Start();
			p.BeginOutputReadLine();
			p.BeginErrorReadLine();
		}
		catch (Exception ex)
		{
			return Fail("Could not start the app's Node runtime: " + ex.Message, "");
		}
		// The background server can inherit the output pipes, so they may never close: wait for
		// the launcher process, not for end of output.
		if (!p.WaitForExit(180000))
			return Fail("The viewer did not start within 3 minutes.", Text(output));
		p.WaitForExit(500);
		var text = Text(output);
		// Pass the launcher's words on when a script or terminal is listening.
		try { Console.Out.Write(text); } catch { }
		return p.ExitCode == 0 ? 0 : Fail("The viewer could not start (exit " + p.ExitCode + ").", text);
	}

	static string Text(StringBuilder sb)
	{
		lock (sb) return sb.ToString();
	}

	static int Fail(string message, string detail)
	{
		var tail = detail.Trim();
		if (tail.Length > 1500) tail = "…" + tail.Substring(tail.Length - 1500);
		var text = message + (tail.Length > 0 ? "\n\n" + tail : "") + "\n\nReport problems at https://github.com/itama8/omakase-cadkit/issues";
		try { Console.Error.WriteLine(text); } catch { }
		// Automated runs (CI) must never wait on a dialog.
		if (Environment.GetEnvironmentVariable("CI") == null) MessageBoxW(IntPtr.Zero, text, "omakase-cadkit", IconError);
		return 1;
	}

	// Windows command-line quoting that CommandLineToArgvW and Node read back unchanged.
	static string Quote(string arg)
	{
		if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
		var sb = new StringBuilder("\"");
		for (var i = 0; ; i++)
		{
			var slashes = 0;
			while (i < arg.Length && arg[i] == '\\') { slashes++; i++; }
			if (i == arg.Length) { sb.Append('\\', slashes * 2); break; }
			if (arg[i] == '"') sb.Append('\\', slashes * 2 + 1).Append('"');
			else sb.Append('\\', slashes).Append(arg[i]);
		}
		return sb.Append('"').ToString();
	}
}
