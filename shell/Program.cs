using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace CodexAssistant
{
    class Program
    {
        static Process uiProcess;
        static Process edgeProcess;
        static string portFile;
        static string pidFile;
        static string appDir;
        static Icon appIcon;

        [STAThread]
        static void Main(string[] args)
        {
            appDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            Directory.SetCurrentDirectory(appDir);

            // Load application icon
            try
            {
                string iconPath = Path.Combine(appDir, "app.ico");
                if (File.Exists(iconPath))
                {
                    appIcon = new Icon(iconPath);
                }
            }
            catch { }

            // Clean up residual processes from previous sessions
            KillResidualProcesses();

            // Check Node.js
            string nodePath = FindNode();
            if (nodePath == null)
            {
                MessageBox.Show(
                    "未找到 Node.js，请先安装 Node.js 18+\n\n下载地址: https://nodejs.org/",
                    "Codex Assistant - 错误",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return;
            }

            // Start UI server (completely hidden — no console window)
            var psi = new ProcessStartInfo
            {
                FileName = "node",
                Arguments = "ui-server.mjs",
                WorkingDirectory = appDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = false,
                RedirectStandardError = false
            };

            try
            {
                uiProcess = Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "启动失败: " + ex.Message,
                    "Codex Assistant - 错误",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return;
            }

            // Write PID file for future residual cleanup
            pidFile = Path.Combine(appDir, ".ui-pid");
            try { File.WriteAllText(pidFile, uiProcess.Id.ToString()); } catch { }

            // Register cleanup on process exit (covers Task Manager kill)
            AppDomain.CurrentDomain.ProcessExit += delegate { Cleanup(); };

            // Wait for port file
            portFile = Path.Combine(appDir, ".ui-port");
            int port = 0;
            for (int i = 0; i < 60; i++)
            {
                Thread.Sleep(500);
                try
                {
                    if (File.Exists(portFile))
                    {
                        string portStr = File.ReadAllText(portFile).Trim();
                        int parsed;
                        if (int.TryParse(portStr, out parsed) && parsed > 0)
                        {
                            port = parsed;
                            break;
                        }
                    }
                }
                catch { }
            }

            if (port == 0)
            {
                MessageBox.Show(
                    "服务启动超时，请检查日志。",
                    "Codex Assistant - 错误",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                Cleanup();
                return;
            }

            // Open browser in Edge app mode (tracked)
            string url = "http://127.0.0.1:" + port + "/";
            try
            {
                edgeProcess = Process.Start(new ProcessStartInfo
                {
                    FileName = "msedge.exe",
                    Arguments = "--app=" + url + " --window-size=1200,800",
                    UseShellExecute = true
                });
            }
            catch
            {
                // Fallback to default browser
                try { Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true }); }
                catch { }
            }

            // Create a hidden form with icon for taskbar presence
            // This ensures the Codex Assistant icon appears in the taskbar
            // even when running as a background process
            var thread = new Thread(() =>
            {
                try
                {
                    Application.EnableVisualStyles();
                    var form = new Form
                    {
                        Text = "Codex Assistant",
                        ShowInTaskbar = true,
                        WindowState = FormWindowState.Minimized,
                        FormBorderStyle = FormBorderStyle.FixedToolWindow,
                        Opacity = 0,
                        StartPosition = FormStartPosition.Manual,
                        Location = new Point(-10000, -10000),
                        Size = new Size(1, 1)
                    };
                    if (appIcon != null)
                    {
                        form.Icon = appIcon;
                    }
                    Application.Run(form);
                }
                catch { }
            });
            thread.SetApartmentState(ApartmentState.STA);
            thread.IsBackground = true;
            thread.Start();

            // Keep process alive until the UI server exits
            try { uiProcess.WaitForExit(); }
            catch { Thread.Sleep(Timeout.Infinite); }

            // If we reach here, the UI server exited — clean up and quit
            Cleanup();
        }

        /// <summary>
        /// Kill residual ui-server.mjs processes from previous sessions.
        /// Reads .ui-pid file to find the old process, then kills it.
        /// </summary>
        static void KillResidualProcesses()
        {
            string pidPath = Path.Combine(appDir, ".ui-pid");
            if (!File.Exists(pidPath)) return;

            try
            {
                string pidStr = File.ReadAllText(pidPath).Trim();
                int oldPid;
                if (int.TryParse(pidStr, out oldPid) && oldPid > 0)
                {
                    try
                    {
                        Process oldProc = Process.GetProcessById(oldPid);
                        if (!oldProc.HasExited)
                        {
                            // Kill the entire old process tree (ui-server + proxy)
                            try
                            {
                                var kps = new ProcessStartInfo
                                {
                                    FileName = "taskkill",
                                    Arguments = "/T /F /PID " + oldPid,
                                    UseShellExecute = false,
                                    CreateNoWindow = true
                                };
                                var kp = Process.Start(kps);
                                kp.WaitForExit(5000);
                            }
                            catch
                            {
                                try { oldProc.Kill(); } catch { }
                            }
                        }
                    }
                    catch { }
                }
            }
            catch { }

            try { File.Delete(pidPath); } catch { }
            try { if (File.Exists(portFile)) File.Delete(portFile); } catch { }
        }

        /// <summary>
        /// Clean up all spawned processes and temp files.
        /// Called on normal exit AND on ProcessExit (Task Manager kill).
        /// </summary>
        static void Cleanup()
        {
            // Kill Edge window
            try { if (edgeProcess != null && !edgeProcess.HasExited) edgeProcess.Kill(); } catch { }

            // Kill the entire node process tree (ui-server + proxy child)
            // On Windows, Process.Kill() only kills the direct process, not children.
            // taskkill /T /F /PID kills the whole tree.
            try
            {
                if (uiProcess != null && !uiProcess.HasExited)
                {
                    try
                    {
                        ProcessStartInfo killPsi = new ProcessStartInfo
                        {
                            FileName = "taskkill",
                            Arguments = "/T /F /PID " + uiProcess.Id,
                            UseShellExecute = false,
                            CreateNoWindow = true,
                            RedirectStandardOutput = true,
                            RedirectStandardError = true
                        };
                        var killProc = Process.Start(killPsi);
                        killProc.WaitForExit(5000);
                    }
                    catch
                    {
                        // Fallback: direct kill (won't kill proxy, but at least kills ui-server)
                        try { uiProcess.Kill(); } catch { }
                    }
                }
            }
            catch { }

            // Clean up temp files
            try { if (File.Exists(portFile)) File.Delete(portFile); } catch { }
            try { if (File.Exists(pidFile)) File.Delete(pidFile); } catch { }
        }

        static string FindNode()
        {
            // 1. Check PATH
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "node",
                    Arguments = "--version",
                    RedirectStandardOutput = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                var p = Process.Start(psi);
                string ver = p.StandardOutput.ReadToEnd().Trim();
                p.WaitForExit();
                if (p.ExitCode == 0 && ver.StartsWith("v"))
                {
                    return "node (PATH)";
                }
            }
            catch { }

            // 2. Check common locations
            string[] paths = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe"),
                @"C:\Program Files\nodejs\node.exe",
                @"C:\Program Files (x86)\nodejs\node.exe",
            };

            foreach (string p in paths)
            {
                if (File.Exists(p))
                {
                    return p;
                }
            }

            return null;
        }
    }
}
