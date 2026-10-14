#!/usr/bin/env python3
"""Parent-owned process lifeline. No daemon or persisted execution."""

import ctypes
import os
import select
import signal
import subprocess
import sys
import time


def processes():
    result = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,pgid=,lstart="],
        capture_output=True,
        text=True,
        check=True,
        timeout=2,
    )
    table = {}
    for line in result.stdout.splitlines():
        fields = line.split()
        table[int(fields[0])] = (int(fields[1]), int(fields[2]), " ".join(fields[3:]))
    return table


def descendants(table, roots):
    found = set(roots)
    while True:
        added = {pid for pid, (parent, _, _) in table.items() if parent in found}
        if added <= found:
            return found
        found |= added


def send(groups, sig):
    for group in groups:
        try:
            os.killpg(group, sig)
        except ProcessLookupError:
            pass


def main():
    arguments = sys.argv[1:]
    if not arguments:
        raise SystemExit("usage: guard COMMAND [ARG ...]; parent lifeline on fd 3")
    lifeline = 3
    if arguments[0] == "--lifeline-fd":
        lifeline = int(arguments[1])
        arguments = arguments[2:]
    # Only the owning Pi holds the writer. Descendants cannot keep it alive.
    os.set_inheritable(lifeline, False)
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    subreaper = sys.platform.startswith("linux")
    if subreaper and ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "Cannot establish agent child subreaper")
    child = subprocess.Popen(arguments, start_new_session=True, close_fds=True)
    groups = {child.pid}
    tracked = {}
    next_scan = 0.0

    def scan():
        nonlocal tracked, groups
        table = processes()
        roots = {os.getpid()}
        if not subreaper:
            # Darwin lacks Linux child-subreaper adoption. Retain observed orphan
            # identities, checking birth time before using their current group.
            roots |= {
                pid
                for pid, birth in tracked.items()
                if pid in table and table[pid][2] == birth
            }
        owned = descendants(table, roots)
        tracked = {pid: table[pid][2] for pid in owned if pid in table}
        groups = {table[pid][1] for pid in owned if pid in table}
        groups.discard(os.getpgrp())
        groups.discard(0)

    try:
        while not stopping:
            readable, _, _ = select.select([lifeline], [], [], 0.1)
            if readable and not os.read(lifeline, 4096):
                break
            if time.monotonic() >= next_scan:
                scan()
                next_scan = time.monotonic() + 0.5
            if child.poll() is not None:
                break
    finally:
        # Freeze the live worker before scanning so it cannot start another tool.
        if child.returncode is None:
            send({child.pid}, signal.SIGSTOP)
        try:
            scan()
            send(groups, signal.SIGSTOP)
            scan()
            send(groups, signal.SIGSTOP)
        except (OSError, subprocess.SubprocessError):
            print(
                "pi-agents: descendant scan failed; cleaning known groups",
                file=sys.stderr,
            )
        send(groups, signal.SIGTERM)
        send(groups, signal.SIGCONT)
        try:
            child.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            pass
        # Leader exit does not prove that all tool processes exited.
        send(groups, signal.SIGKILL)
        child.wait()
        if subreaper:
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                try:
                    if os.waitpid(-1, os.WNOHANG)[0] == 0:
                        time.sleep(0.02)
                except ChildProcessError:
                    break
    return child.returncode if child.returncode >= 0 else 128 - child.returncode


if __name__ == "__main__":
    raise SystemExit(main())
