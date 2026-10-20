"""
Converts one Office file to PDF with Microsoft Office (Windows only).

Runs as its own process so a stuck Word/Excel/PowerPoint can be stopped:
    python office_com_worker.py Word|Excel|PowerPoint <source> <output.pdf>
Exit code 0 on success; the error goes to stderr otherwise.
"""

import sys


def convert(kind: str, src: str, out_pdf: str) -> None:
    import pythoncom
    import win32com.client

    pythoncom.CoInitialize()
    app = doc = None
    try:
        app = win32com.client.DispatchEx(f"{kind}.Application")
        # Office runs macros in files it opens through automation unless told not to, so a
        # .doc with an AutoOpen macro would run code on this computer. 3 = force-disable.
        app.AutomationSecurity = 3  # msoAutomationSecurityForceDisable
        if kind == "Word":
            app.Visible = False
            app.DisplayAlerts = 0
            try:
                app.Options.UpdateLinksAtOpen = False  # don't fetch linked files or pictures
            except Exception:
                pass
            # A dummy password makes protected files fail fast instead of showing a prompt.
            doc = app.Documents.Open(src, False, True, False, "__ultrapdf__", "", False, "", "", 0, 0, False, True, 0, True)
            doc.ExportAsFixedFormat(out_pdf, 17)  # wdExportFormatPDF
        elif kind == "Excel":
            app.Visible = False
            app.DisplayAlerts = False
            app.AskToUpdateLinks = False
            app.ScreenUpdating = False
            doc = app.Workbooks.Open(src, 0, True, None, "__ultrapdf__")
            # Every column on one page width, as many pages tall as needed.
            try:
                app.PrintCommunication = False
            except Exception:
                pass
            for ws in doc.Worksheets:
                try:
                    ps = ws.PageSetup
                    ps.Zoom = False
                    ps.FitToPagesWide = 1
                    ps.FitToPagesTall = False
                    if ws.UsedRange.Columns.Count > 7:
                        ps.Orientation = 2  # xlLandscape
                except Exception:
                    pass
            try:
                app.PrintCommunication = True
            except Exception:
                pass
            doc.ExportAsFixedFormat(0, out_pdf)  # xlTypePDF
        else:
            app.DisplayAlerts = 1  # ppAlertsNone
            doc = app.Presentations.Open(src, True, False, False)  # ReadOnly, Untitled, WithWindow
            doc.SaveAs(out_pdf, 32)  # ppSaveAsPDF
    finally:
        if doc is not None:
            try:
                doc.Close(0) if kind == "Word" else doc.Close(False) if kind == "Excel" else doc.Close()
            except Exception:
                pass
        if app is not None:
            try:
                app.Quit()
            except Exception:
                pass
        doc = app = None
        pythoncom.CoUninitialize()


if __name__ == "__main__":
    try:
        convert(sys.argv[1], sys.argv[2], sys.argv[3])
    except Exception as exc:  # reported to the server through stderr
        sys.stderr.write(f"{type(exc).__name__}: {exc}\n")
        sys.exit(1)
