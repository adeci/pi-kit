"""Offline actual-Pi tests for the question UI, RPC and mode composition."""

import fcntl
import json
import os
import pty
import queue
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import threading
import time
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[2]
PI = os.environ.get("PI_BINARY", "pi")
ANSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")


def setup(home, mode="regular"):
    profile = home / "profile"
    (profile / "extensions").mkdir(parents=True)
    for name in ["ask", "goal", "director"]:
        path = Path(
            os.environ.get(f"PI_{name.upper()}_EXTENSION", SOURCE / name / "extension")
        ).resolve()
        (profile / "extensions" / f"kit-{name}").symlink_to(path)
    settings = {
        "tuiMode": mode,
        "compaction": {"enabled": False},
        "retry": {"enabled": False},
    }
    theme = os.environ.get("PI_ASK_TEST_THEME")
    if theme:
        (profile / "themes").mkdir()
        (profile / "themes/tokyo-night.json").symlink_to(Path(theme).resolve())
        settings["theme"] = "tokyo-night"
    (profile / "settings.json").write_text(json.dumps(settings))
    trace = home / "trace"
    env = {
        **os.environ,
        "HOME": str(home),
        "PI_CODING_AGENT_DIR": str(profile),
        "PI_ASK_TRACE": str(trace),
        "PI_SKIP_VERSION_CHECK": "1",
    }
    args = [
        PI,
        "--offline",
        "--provider",
        "ask-fixture",
        "--model",
        "scripted",
        "--thinking",
        "off",
        "-e",
        str(SOURCE / "ask/tests/fixture.ts"),
    ]
    return args, env, trace


def records(trace):
    return (
        [
            json.loads(line)
            for line in trace.read_text().splitlines()
            if line.endswith("}")
        ]
        if trace.exists()
        else []
    )


def tui(scenario, mode="regular"):
    with tempfile.TemporaryDirectory(prefix="kit-ask-") as temp:
        home = Path(temp)
        args, env, trace = setup(home, mode)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        proc = subprocess.Popen(
            args,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            cwd=home,
            env=env,
            start_new_session=True,
        )
        os.close(slave)
        output = bytearray()

        def text():
            return ANSI.sub(b"", output).decode("utf8", "replace")

        def entries(event):
            return [row for row in records(trace) if row["event"] == event]

        def wait(predicate):
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if predicate():
                    return
                assert proc.poll() is None, text()[-5000:]
                ready, _, _ = select.select([master], [], [], 0.05)
                if ready:
                    output.extend(os.read(master, 65536))
            raise AssertionError(
                f"{scenario}/{mode}: {text()[-6000:]}\n{records(trace)[-5:]}"
            )

        def key(value):
            output.clear()
            os.write(master, value)

        def send(value):
            key(b"\x1b[200~" + value.encode() + b"\x1b[201~\r")

        try:
            wait(lambda: entries("start") and "scripted" in text())
            if os.environ.get("PI_ASK_TEST_THEME"):
                assert entries("start")[-1]["theme"] == "tokyo-night"
            if scenario == "director":
                send("/director")
                wait(lambda: "Director: Off" in text())
                key(b"\r")
                wait(lambda: "Director: On" in text())
                before = len(entries("ui_end"))
                key(b"\x1b")
                wait(lambda: len(entries("ui_end")) > before)
            send(
                "/goal Ask for scope"
                if scenario == "goal"
                else "/guided-goal Clarify scope"
                if scenario == "guided"
                else "Ask me the questions"
            )
            wait(lambda: "Which scope should we use?" in text())
            assert not entries("result"), (
                "Recommendation was submitted without user action"
            )
            key(b"\r")
            wait(lambda: "Which checks should run?" in text())
            if scenario in ["goal", "guided", "director", "cancel"]:
                key(b"\x1b")
                wait(lambda: entries("result") and entries("settled"))
                assert entries("result")[-1]["details"]["status"] == "cancelled"
                assert entries("result")[-1]["details"]["answers"] == []
                assert len(entries("request")) == 1, (
                    "Cancellation resumed model execution"
                )
                if scenario == "goal":
                    send("/ask-audit")
                    wait(lambda: entries("audit"))
                    goals = [
                        e["data"]["state"]
                        for e in entries("audit")[-1]["entries"]
                        if e.get("customType") == "pi-kit:goal:v1"
                    ]
                    assert goals[-1]["goal"]["status"] == "paused", goals[-1]
            else:
                key(b" ")
                wait(lambda: "[x] Unit tests" in text())
                key(b"\x1b[B ")
                wait(lambda: "[x] Integration tests" in text())
                # Narrow resize exercises the shared frame and wrapped labels.
                fcntl.ioctl(
                    master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 70, 0, 0)
                )
                proc.send_signal(signal.SIGWINCH)
                key(b"\r")
                wait(lambda: "Any additional constraints?" in text())
                key(b"\r")
                wait(lambda: "Your answer" in text())
                key(b"No deployment\r")
                wait(lambda: "Submit answers" in text())
                assert not entries("result"), "Review auto-submitted"
                key(b"\x1b[D")
                wait(lambda: "Write your answer" in text())
                key(b"\r")
                wait(lambda: "Your answer" in text())
                key(b"\x1b")
                wait(lambda: "Write your answer" in text())
                key(b"\x1b[C")
                wait(lambda: "Submit answers" in text())
                key(b"\r")
                wait(lambda: entries("result") and entries("settled"))
                details = entries("result")[-1]["details"]
                assert details["status"] == "answered", details
                assert details["answers"] == [
                    {"id": "scope", "selected": ["small"], "text": ""},
                    {"id": "checks", "selected": ["unit", "integration"], "text": ""},
                    {"id": "notes", "selected": [], "text": "No deployment"},
                ], details
                assert len(entries("request")) == 2
            print(f"PASS tui {scenario} ({mode})", flush=True)
        finally:
            proc.terminate()
            proc.wait(timeout=10)
            os.close(master)


def rpc(cancel=False, reload=False):
    with tempfile.TemporaryDirectory(prefix="kit-ask-rpc-") as temp:
        home = Path(temp)
        args, env, trace = setup(home)
        proc = subprocess.Popen(
            args + ["--mode", "rpc"],
            cwd=home,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        events = queue.Queue()

        def reader():
            for line in proc.stdout:
                try:
                    events.put(json.loads(line))
                except json.JSONDecodeError:
                    pass

        threading.Thread(target=reader, daemon=True).start()

        def send(value):
            proc.stdin.write(json.dumps(value) + "\n")
            proc.stdin.flush()

        try:
            send({"type": "prompt", "message": "Ask me"})
            deadline = time.monotonic() + 20
            dialogs = 0
            reopened = False
            old_request = None
            while time.monotonic() < deadline:
                if (
                    reload
                    and not reopened
                    and len([e for e in records(trace) if e["event"] == "start"]) == 2
                ):
                    reopened = True
                    send(
                        {
                            "type": "extension_ui_response",
                            "id": old_request["id"],
                            "value": old_request["options"][0],
                        }
                    )
                    send({"type": "prompt", "message": "Ask again after reload"})
                try:
                    event = events.get(timeout=0.1)
                except queue.Empty:
                    continue
                if event.get("type") == "extension_ui_request" and event["method"] in [
                    "select",
                    "input",
                    "confirm",
                ]:
                    dialogs += 1
                    response = {"type": "extension_ui_response", "id": event["id"]}
                    if reload:
                        if dialogs == 1:
                            old_request = event
                            send({"type": "prompt", "message": "/ask-reload"})
                        else:
                            response["cancelled"] = True
                            send(response)
                    elif cancel:
                        send({"type": "abort"})
                        # No UI reply: the abort signal must settle the dialog.
                        cancel = False
                    elif event["method"] == "confirm":
                        response["confirmed"] = True
                        send(response)
                    elif event["method"] == "input":
                        response["value"] = "No deployment"
                        send(response)
                    else:
                        response["value"] = (
                            "Next question"
                            if any("[x]" in x for x in event["options"])
                            else event["options"][0]
                        )
                        send(response)
                if event.get("type") == "agent_end" and (not reload or dialogs > 1):
                    break
            else:
                raise AssertionError("RPC did not finish")
            results = [e for e in records(trace) if e["event"] == "result"]
            assert results and results[-1]["details"]["status"] in [
                "answered",
                "cancelled",
            ], records(trace)
            status = results[-1]["details"]["status"]
            assert status == ("cancelled" if dialogs == 1 or reload else "answered")
            if reload:
                assert reopened and dialogs == 2
                assert len(results) == 2 and all(
                    r["details"]["status"] == "cancelled"
                    and not r["details"]["answers"]
                    for r in results
                )
            print(
                f"PASS rpc {'reload and stale response' if reload else status}",
                flush=True,
            )
        finally:
            proc.terminate()
            proc.wait(timeout=10)


def headless():
    with tempfile.TemporaryDirectory(prefix="kit-ask-print-") as temp:
        home = Path(temp)
        args, env, trace = setup(home)
        run = subprocess.run(
            args + ["--print", "Ask me"],
            stdin=subprocess.DEVNULL,
            cwd=home,
            env=env,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        assert run.returncode == 0, run.stderr
        results = [r for r in records(trace) if r["event"] == "result"]
        assert results[-1]["details"]["status"] == "unavailable", results
        assert len([r for r in records(trace) if r["event"] == "request"]) == 1
        print("PASS headless unavailable", flush=True)


if __name__ == "__main__":
    for case in ["answered", "cancel", "goal", "guided", "director"]:
        tui(case)
    tui("answered", "fullscreen")
    rpc()
    rpc(cancel=True)
    rpc(reload=True)
    headless()
