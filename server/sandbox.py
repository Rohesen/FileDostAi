"""
Runs each server job (anything that parses an uploaded file) in its own short-lived process
with a time limit and a memory cap, and caps how many jobs run at once. A malicious or broken
file can then only crash or stall its own job: the web server keeps answering everyone else.

Settings (environment variables):
  ULTRAPDF_SANDBOX         "1" runs jobs in separate processes, "0" in the server process.
                           Default: on for Linux/macOS, off on Windows (no fast fork there).
  ULTRAPDF_MAX_JOBS        jobs that may run at the same time, default CPU count (at least 2)
  ULTRAPDF_JOB_TIMEOUT     seconds before a job is stopped, default 300
  ULTRAPDF_JOB_MEMORY_MB   memory cap per job in MB, default 3072 (0 = no cap)
  ULTRAPDF_QUEUE_WAIT      seconds a request waits for a free slot before "busy", default 90
"""

import logging
import multiprocessing
import os
import threading
import traceback

log = logging.getLogger("ultrapdf.sandbox")


class ServerBusyError(RuntimeError):
    """Every job slot stayed taken for the whole wait; the user should try again shortly."""


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def enabled() -> bool:
    flag = os.environ.get("ULTRAPDF_SANDBOX")
    if flag is not None:
        return flag == "1"
    return os.name == "posix"


MAX_JOBS = max(1, _env_int("ULTRAPDF_MAX_JOBS", max(2, os.cpu_count() or 2)))
JOB_TIMEOUT = max(5, _env_int("ULTRAPDF_JOB_TIMEOUT", 300))
JOB_MEMORY_MB = max(0, _env_int("ULTRAPDF_JOB_MEMORY_MB", 3072))
QUEUE_WAIT = max(0, _env_int("ULTRAPDF_QUEUE_WAIT", 90))

_slots = threading.BoundedSemaphore(MAX_JOBS)
_ctx = None
_ctx_lock = threading.Lock()


def _context():
    # forkserver: each job is forked from a small single-threaded server process that already
    # has the PDF libraries loaded, so starting a job is fast and never copies the web
    # server's threads or locks.
    global _ctx
    with _ctx_lock:
        if _ctx is None:
            methods = multiprocessing.get_all_start_methods()
            _ctx = multiprocessing.get_context("forkserver" if "forkserver" in methods else "spawn")
            if "forkserver" in methods:
                _ctx.set_forkserver_preload(["pdf_engine", "converters"])
        return _ctx


def _limit_resources(memory_mb: int, cpu_seconds: int) -> None:
    try:
        import resource
    except ImportError:
        return
    if memory_mb:
        cap = memory_mb * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (cap, cap))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 5))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def _child(conn, fn, args, memory_mb, cpu_seconds):
    try:
        _limit_resources(memory_mb, cpu_seconds)
        outcome = ("ok", fn(*args), "")
    except BaseException as exc:  # sent back and re-raised in the server
        outcome = ("error", exc, traceback.format_exc(limit=20))
    try:
        conn.send(outcome)
    except Exception as exc:  # the result or the error could not be pickled
        conn.send(("error", RuntimeError(f"{type(exc).__name__}: {exc}"[:500]), outcome[2]))
    finally:
        conn.close()


def _run_isolated(fn, args):
    ctx = _context()
    parent, child = ctx.Pipe(duplex=False)
    proc = ctx.Process(target=_child, args=(child, fn, args, JOB_MEMORY_MB, JOB_TIMEOUT))
    proc.start()
    child.close()
    try:
        if not parent.poll(JOB_TIMEOUT):
            raise ValueError("Processing took too long and was stopped. Try a smaller or simpler file.")
        try:
            status, value, child_tb = parent.recv()
        except EOFError:
            # The process died without answering: killed for using too much memory or CPU,
            # or the file crashed the PDF library.
            log.warning("job %s ended without a result (exit code %s)", getattr(fn, "__qualname__", fn), proc.exitcode)
            raise ValueError("This file could not be processed safely. It may be damaged, or too large or "
                             "complex for the server.")
    finally:
        parent.close()
        if proc.is_alive():
            proc.kill()
        proc.join(5)
    if status == "ok":
        return value
    if child_tb and hasattr(value, "add_note"):
        value.add_note("In the job process:\n" + child_tb)  # shows up in the server log
    if isinstance(value, MemoryError):
        raise ValueError("This file needs more memory than the server allows for one job. Try a smaller file.")
    raise value


def run_job(fn, *args):
    """Runs fn(*args) under the job limits and returns its result; errors are re-raised here.
    fn must be a module-level function or static method so it can be sent to the job process."""
    if not _slots.acquire(timeout=QUEUE_WAIT):
        raise ServerBusyError("The server is busy right now. Please try again in a minute.")
    try:
        if enabled():
            return _run_isolated(fn, args)
        return fn(*args)
    finally:
        _slots.release()
