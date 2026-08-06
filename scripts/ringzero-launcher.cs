// RingZero self-extracting launcher (Windows).
//
// The payload (node.exe + the compiled app + production dependencies) is
// embedded as a managed resource named "RingZero.Payload" at compile time by
// scripts/build-sfx.mjs. On first run it is extracted to
// %LOCALAPPDATA%\RingZero\<version>\ and then node executes the CLI with the
// user's arguments.
//
// Kept at C# 5 so it compiles with the .NET Framework csc.exe that ships with
// Windows — no other toolchain needed. The .NET Framework 4.x runtime is
// built into Windows 10/11.
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;

class RingZeroLauncher
{
    private const string Version = "__RINGZERO_VERSION__";
    private const string ResourceName = "RingZero.Payload";

    private static string AppDir()
    {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return Path.Combine(local, "RingZero", Version);
    }

    private static void ExtractIfNeeded(string dir)
    {
        string marker = Path.Combine(dir, ".complete");
        if (File.Exists(marker))
        {
            return;
        }
        try
        {
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, true);
            }
        }
        catch
        {
            // Dir in use (a previous run is still active) — extract over it.
        }
        Directory.CreateDirectory(dir);
        using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName))
        {
            if (stream == null)
            {
                throw new InvalidOperationException("embedded payload resource not found");
            }
            // .NET Framework's ZipFile has no (Stream, string) overload, so
            // materialize the payload to a temp file first.
            string tmp = Path.Combine(Path.GetTempPath(), "ringzero-payload-" + Version + ".zip");
            try
            {
                using (FileStream fs = new FileStream(tmp, FileMode.Create, FileAccess.Write))
                {
                    stream.CopyTo(fs);
                }
                ZipFile.ExtractToDirectory(tmp, dir);
            }
            finally
            {
                try
                {
                    File.Delete(tmp);
                }
                catch
                {
                }
            }
        }
        try
        {
            File.WriteAllText(marker, "ok");
        }
        catch
        {
        }
        // Best-effort cleanup of OLDER versions (never newer ones — a newer
        // launcher may still be running from its extracted dir).
        try
        {
            string root = Path.GetDirectoryName(dir);
            if (root != null)
            {
                foreach (string d in Directory.GetDirectories(root))
                {
                    if (CompareVersion(Path.GetFileName(d), Version) < 0)
                    {
                        try
                        {
                            Directory.Delete(d, true);
                        }
                        catch
                        {
                        }
                    }
                }
            }
        }
        catch
        {
        }
    }

    private static int CompareVersion(string a, string b)
    {
        string[] pa = a.Split('.');
        string[] pb = b.Split('.');
        int n = Math.Max(pa.Length, pb.Length);
        for (int i = 0; i < n; i++)
        {
            int x = i < pa.Length ? ParseNum(pa[i]) : 0;
            int y = i < pb.Length ? ParseNum(pb[i]) : 0;
            if (x != y)
            {
                return x < y ? -1 : 1;
            }
        }
        return 0;
    }

    private static int ParseNum(string s)
    {
        int v;
        return int.TryParse(s, out v) ? v : 0;
    }

    private static string Quote(string a)
    {
        return "\"" + a.Replace("\"", "\\\"") + "\"";
    }

    private static int Main(string[] args)
    {
        string dir = AppDir();
        try
        {
            ExtractIfNeeded(dir);
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("[ringzero] failed to initialize: " + e.Message);
            return 1;
        }

        string node = Path.Combine(dir, "node.exe");
        string script = Path.Combine(dir, "dist", "src", "cli", "index.js");
        string arguments = Quote(script);
        if (args.Length > 0)
        {
            string[] quoted = new string[args.Length];
            for (int i = 0; i < args.Length; i++)
            {
                quoted[i] = Quote(args[i]);
            }
            arguments = arguments + " " + string.Join(" ", quoted);
        }

        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(node);
            psi.UseShellExecute = false;
            psi.Arguments = arguments;
            Process p = Process.Start(psi);
            p.WaitForExit();
            return p.ExitCode;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("[ringzero] failed to start: " + e.Message);
            return 1;
        }
    }
}
