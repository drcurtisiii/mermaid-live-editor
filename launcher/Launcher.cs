// Mermaid View Edit launcher.
//
// The release exe is this small program with the whole application embedded as
// a zip resource ("payload.zip"). On the first run of a version it unpacks the
// app once to %LOCALAPPDATA%\MermaidViewEdit\app\<version>-<payload id>\ and
// every later run just starts it from there (about a second instead of
// re-unpacking ~400 MB each time). The launcher exits as soon as the app has
// started, so the release exe is not kept locked (Dropbox / Common Software).
//
// Compiled by build.ps1 with the C# 5 compiler that ships with Windows
// (.NET Framework 4.x), so keep the syntax C# 5.

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

internal static class Launcher
{
    private const string AppName = "Mermaid View Edit";
    private const string InnerExe = "Mermaid View Edit.exe";
    private const string Marker = ".complete";

    private static string dataDir;

    [STAThread]
    private static int Main()
    {
        try
        {
            dataDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "MermaidViewEdit");
            Assembly assembly = Assembly.GetExecutingAssembly();
            string version = GetVersion(assembly);
            string payloadId = ReadTextResource(assembly, "payload.id").Trim();
            string appRoot = Path.Combine(dataDir, "app");
            string installDir = Path.Combine(appRoot, version + "-" + payloadId);

            if (!File.Exists(Path.Combine(installDir, Marker)))
            {
                Install(assembly, appRoot, installDir, version);
            }

            string self = assembly.Location;
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = Path.Combine(installDir, InnerExe);
            start.Arguments = ArgumentTail(Environment.CommandLine);
            start.WorkingDirectory = Environment.CurrentDirectory;
            start.UseShellExecute = false;
            // The app uses these to find the release exe (updates, shortcuts).
            start.EnvironmentVariables["PORTABLE_EXECUTABLE_FILE"] = self;
            start.EnvironmentVariables["PORTABLE_EXECUTABLE_DIR"] = Path.GetDirectoryName(self);
            using (Process child = Process.Start(start))
            {
                if (child == null)
                {
                    throw new InvalidOperationException("The application did not start.");
                }
            }

            Prune(appRoot, installDir);
            return 0;
        }
        catch (Exception error)
        {
            Log("launch failed: " + error);
            MessageBox.Show(
                AppName + " could not start.\n\n" + error.Message,
                AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static string GetVersion(Assembly assembly)
    {
        object[] attributes = assembly.GetCustomAttributes(
            typeof(AssemblyInformationalVersionAttribute), false);
        if (attributes.Length == 0)
        {
            throw new InvalidOperationException("Launcher has no version.");
        }
        return ((AssemblyInformationalVersionAttribute)attributes[0]).InformationalVersion;
    }

    private static string ReadTextResource(Assembly assembly, string name)
    {
        using (Stream stream = assembly.GetManifestResourceStream(name))
        {
            if (stream == null)
            {
                throw new InvalidOperationException("Missing resource: " + name);
            }
            using (StreamReader reader = new StreamReader(stream))
            {
                return reader.ReadToEnd();
            }
        }
    }

    /// Everything after the program name, exactly as Windows passed it
    /// (keeps the quoting of dropped file paths intact).
    internal static string ArgumentTail(string commandLine)
    {
        string line = commandLine.TrimStart();
        int end;
        if (line.StartsWith("\""))
        {
            end = line.IndexOf('"', 1);
            end = end < 0 ? line.Length : end + 1;
        }
        else
        {
            end = line.IndexOf(' ');
            if (end < 0)
            {
                end = line.Length;
            }
        }
        return line.Substring(end).Trim();
    }

    private static void Install(Assembly assembly, string appRoot, string installDir, string version)
    {
        Directory.CreateDirectory(appRoot);
        string temp = installDir + ".tmp-" + Process.GetCurrentProcess().Id;
        Exception failure = null;

        Application.EnableVisualStyles();
        using (Form splash = CreateSplash(version))
        {
            Thread worker = new Thread(delegate()
            {
                try
                {
                    Extract(assembly, temp);
                }
                catch (Exception error)
                {
                    failure = error;
                }
                try
                {
                    splash.BeginInvoke(new MethodInvoker(splash.Close));
                }
                catch (InvalidOperationException)
                {
                    // Splash already gone.
                }
            });
            worker.IsBackground = true;
            splash.Shown += delegate { worker.Start(); };
            Application.Run(splash);
            worker.Join();
        }

        if (failure != null)
        {
            TryDelete(temp);
            throw new IOException("Could not unpack the application: " + failure.Message, failure);
        }

        if (Directory.Exists(installDir))
        {
            if (File.Exists(Path.Combine(installDir, Marker)))
            {
                // Another launcher finished first; use its copy.
                TryDelete(temp);
                return;
            }
            // Left over from an interrupted install.
            Directory.Delete(installDir, true);
        }
        try
        {
            Directory.Move(temp, installDir);
        }
        catch (IOException)
        {
            if (!File.Exists(Path.Combine(installDir, Marker)))
            {
                throw;
            }
            TryDelete(temp);
        }
        Log("installed " + Path.GetFileName(installDir));
    }

    private static void Extract(Assembly assembly, string temp)
    {
        TryDelete(temp);
        Directory.CreateDirectory(temp);
        string root = Path.GetFullPath(temp) + Path.DirectorySeparatorChar;
        using (Stream stream = assembly.GetManifestResourceStream("payload.zip"))
        {
            if (stream == null)
            {
                throw new InvalidOperationException("Missing resource: payload.zip");
            }
            using (ZipArchive archive = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string target = Path.GetFullPath(Path.Combine(temp, entry.FullName));
                    if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidDataException("Unexpected path in payload: " + entry.FullName);
                    }
                    if (entry.FullName.EndsWith("/") || entry.FullName.EndsWith("\\"))
                    {
                        Directory.CreateDirectory(target);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    entry.ExtractToFile(target, true);
                }
            }
        }
        if (!File.Exists(Path.Combine(temp, InnerExe)))
        {
            throw new InvalidDataException("Payload does not contain " + InnerExe);
        }
        // Written last: its presence means the copy is complete.
        File.WriteAllText(Path.Combine(temp, Marker), DateTime.UtcNow.ToString("o"));
    }

    private static Form CreateSplash(string version)
    {
        Form form = new Form();
        form.Text = AppName;
        form.FormBorderStyle = FormBorderStyle.FixedDialog;
        form.ControlBox = false;
        form.StartPosition = FormStartPosition.CenterScreen;
        form.ClientSize = new Size(420, 96);
        form.ShowInTaskbar = true;
        form.TopMost = true;
        try
        {
            form.Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);
        }
        catch (Exception)
        {
            // Icon is cosmetic.
        }

        Label label = new Label();
        label.Text = "Setting up " + AppName + " v" + version
            + " (first run only, about half a minute)...";
        label.SetBounds(16, 14, 388, 36);
        form.Controls.Add(label);

        ProgressBar bar = new ProgressBar();
        bar.Style = ProgressBarStyle.Marquee;
        bar.MarqueeAnimationSpeed = 30;
        bar.SetBounds(16, 56, 388, 20);
        form.Controls.Add(bar);
        return form;
    }

    /// Removes unpacked copies of other versions that are not running, and
    /// stale temp folders. A folder that is in use cannot be renamed, so a
    /// running older version is never touched.
    private static void Prune(string appRoot, string keep)
    {
        try
        {
            foreach (string dir in Directory.GetDirectories(appRoot))
            {
                if (string.Equals(dir, keep, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                string name = Path.GetFileName(dir);
                bool leftover = name.Contains(".tmp-") || name.EndsWith(".delete");
                if (leftover && Directory.GetLastWriteTimeUtc(dir) > DateTime.UtcNow.AddHours(-1))
                {
                    continue; // may belong to a launcher that is still unpacking
                }
                string doomed = leftover ? dir : dir + ".delete";
                try
                {
                    if (!leftover)
                    {
                        Directory.Move(dir, doomed);
                    }
                    Directory.Delete(doomed, true);
                    Log("removed old copy " + name);
                }
                catch (Exception)
                {
                    // In use or locked; try again on a later launch.
                }
            }
        }
        catch (Exception error)
        {
            Log("prune: " + error.Message);
        }
    }

    private static void TryDelete(string dir)
    {
        try
        {
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, true);
            }
        }
        catch (Exception)
        {
            // Best effort; Prune cleans up later.
        }
    }

    private static void Log(string message)
    {
        try
        {
            string logDir = Path.Combine(dataDir, "logs");
            Directory.CreateDirectory(logDir);
            File.AppendAllText(
                Path.Combine(logDir, "launcher.log"),
                DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine);
        }
        catch (Exception)
        {
            // Logging must never stop the launch.
        }
    }
}
