"""Offline real-Pi completion receipts, batching, reload and TUI regression tests."""

import fcntl
import json
import os
import pty
import re
import select
import shlex
import signal
import socket
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

import integration

integration.FIXTURE = Path(__file__).with_name("completion-fixture.ts")
SOURCE = Path(__file__).resolve().parents[2]
EVENTS = os.environ.get(
    "PI_EVENTS_TEST_EXTENSION", str(SOURCE / "events/extension/index.ts")
)
ANSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")


def setup(directory):
    profile = directory / "profile"
    profile.mkdir()
    (directory / "runtime").mkdir(mode=0o700)
    (profile / "settings.json").write_text(
        json.dumps({"retry": {"enabled": False}, "compaction": {"enabled": False}})
    )
    config = directory / "agents.json"
    config.write_text(
        json.dumps(
            {
                "version": 1,
                "maxConcurrency": 2,
                "roles": {
                    "scout": {
                        "model": "pi-agents-fixture/scripted",
                        "writable": False,
                        "extensions": [str(integration.FIXTURE)],
                    }
                },
            }
        )
    )
    env = {
        key: value
        for key, value in os.environ.items()
        if key in {"PATH", "SHELL", "LANG", "LC_ALL", "TMPDIR"}
    }
    env.update(
        {
            "HOME": str(directory),
            "PI_CODING_AGENT_DIR": str(profile),
            "PI_AGENTS_CONFIG": str(config),
            "PI_AGENTS_STATE_DIR": str(directory / "state"),
            "XDG_RUNTIME_DIR": str(directory / "runtime"),
            "PI_COMPLETION_TRACE": str(directory / "trace"),
            "PI_SKIP_VERSION_CHECK": "1",
        }
    )
    return env


def records(directory):
    path = directory / "trace"
    return (
        [json.loads(line) for line in path.read_text().splitlines()]
        if path.exists()
        else []
    )


def run(mode, expected, job_read=False, abort=None):
    with tempfile.TemporaryDirectory(prefix="kc-", dir="/tmp") as temporary:
        directory = Path(temporary)
        env = setup(directory)
        handle = "12:" + "a" * 32
        header = f"job={handle} success exit=0 (build) elapsed=3s"
        payload = {
            "handle": handle,
            "owner": "fixture",
            "name": "build",
            "state": "success",
            "exit_code": 0,
            "elapsed_seconds": 3,
            "text": f"job={handle} (build) success exit=0 elapsed=3s\nretained output\nFull output: pi-jobs log {handle}",
        }
        if mode == "job":
            script = directory / "command.py"
            script.write_text(
                "from pathlib import Path\nimport time\nPath('ready').touch()\ndeadline=time.monotonic()+15\nwhile not Path('release').exists():\n assert time.monotonic()<deadline\n time.sleep(.01)\n"
                + f"print({(header + chr(10) + 'retained output' if job_read else 'wait interval elapsed')!r})\n"
            )
            env["PI_COMPLETION_JOB_COMMAND"] = "python3 " + shlex.quote(str(script))
        pi = integration.Pi(env, directory, directory, extensions=[EVENTS])
        try:
            pi.call("prompt", message="COMPLETION " + mode)
            if mode == "job":
                integration.until(lambda: (directory / "ready").exists())
                subscriptions = list((directory / "runtime/pi-events").glob("*.json"))
                assert subscriptions, pi.seen
                subscription = json.loads(subscriptions[0].read_text())
                frame = {
                    "version": 1,
                    "subscription": subscription["id"],
                    "token": subscription["token"],
                    "event": {
                        "version": 1,
                        "id": "b" * 32,
                        "topic": "job.completed",
                        "source": "pi-jobs",
                        "payload": payload,
                    },
                }
                with socket.socket(socket.AF_UNIX) as client:
                    client.settimeout(5)
                    client.connect(
                        str(
                            directory
                            / "runtime/pi-events"
                            / (subscription["id"] + ".sock")
                        )
                    )
                    client.sendall(json.dumps(frame).encode())
                    client.shutdown(socket.SHUT_WR)
                    assert json.loads(client.recv(65536))["ok"]
                if abort:
                    pi.call("abort")
                    integration.until(
                        lambda: any(
                            row["type"] == "settled" for row in records(directory)
                        )
                    )
                    assert not any(
                        m.get("role") == "custom"
                        for m in pi.call("get_messages")["messages"]
                    )
                    if abort == "continue":
                        pi.call("prompt", message="CONTINUE")
                else:
                    (directory / "release").touch()
            integration.until(
                lambda: (
                    sum(row["type"] == "settled" for row in records(directory))
                    >= (2 if abort == "continue" else 1)
                )
            )
            messages = pi.call("get_messages")["messages"]
            custom = [
                message for message in messages if message.get("role") == "custom"
            ]
            assert len(custom) == expected, (mode, job_read, custom)
            final = [
                part["text"]
                for message in messages
                if message.get("role") == "assistant"
                for part in message.get("content", [])
                if part["type"] == "text"
            ]
            assert final.count("PRIMARY_DONE") == (0 if abort == "close" else 1), final
            assert final.count("FOLLOW_UP_DONE") == bool(expected), final
            session = pi.call("get_state")["sessionFile"]
        finally:
            pi.close()
        before = len(records(directory))
        resumed = integration.Pi(
            env, directory, directory, session=session, extensions=[EVENTS]
        )
        try:
            assert (
                len(
                    [
                        m
                        for m in resumed.call("get_messages")["messages"]
                        if m.get("role") == "custom"
                    ]
                )
                == expected
            )
            assert not any(
                row["type"] == "custom" for row in records(directory)[before:]
            ), records(directory)[before:]
        finally:
            resumed.close()
        print(
            f"PASS {mode} job_read={job_read} abort={abort}: {expected} notices, at most one batch continuation, no replay"
        )


def tui(mode):
    with tempfile.TemporaryDirectory(prefix="kc-ui-", dir="/tmp") as temporary:
        directory = Path(temporary)
        env = setup(directory)
        (directory / "profile/settings.json").write_text(
            json.dumps({"tuiMode": mode, "theme": "dark"})
        )
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 130, 0, 0))
        args = [
            integration.PI,
            "--offline",
            "--no-extensions",
            "--no-skills",
            "--no-context-files",
            "--no-prompt-templates",
            "--no-themes",
            "-e",
            str(integration.FIXTURE),
            "-e",
            integration.EXTENSION,
            "-e",
            EVENTS,
            "--model",
            "pi-agents-fixture/scripted",
        ]
        process = subprocess.Popen(
            args,
            cwd=directory,
            env=env,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        os.close(slave)
        output = bytearray()

        def text():
            return ANSI.sub(b"", output).decode("utf8", "replace")

        def wait(predicate):
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if predicate():
                    return
                assert process.poll() is None, text()[-8000:]
                ready, _, _ = select.select([master], [], [], 0.05)
                if ready:
                    output.extend(os.read(master, 65536))
            raise AssertionError(text()[-10000:])

        try:
            wait(lambda: any(row["type"] == "start" for row in records(directory)))
            os.write(master, b"\x1b[200~COMPLETION wait\x1b[201~\r")
            wait(
                lambda: (
                    "FOLLOW_UP_DONE" in text()
                    and "Subagent completion-worker" in text()
                )
            )
            assert "EXPAND_ONLY_REPORT_DETAIL" not in text(), text()
            output.clear()
            os.write(master, b"\x0f")
            wait(lambda: "EXPAND_ONLY_REPORT_DETAIL" in text())
            os.write(master, b"\x0f")
            output.clear()
            os.write(master, b"\x1b[200~/fixture-job\x1b[201~\r")
            wait(lambda: "Job render-job" in text())
            assert "JOB_EXPAND_ONLY_DETAIL" not in text(), text()
            output.clear()
            os.write(master, b"\x0f")
            wait(lambda: "JOB_EXPAND_ONLY_DETAIL" in text())
            os.write(master, b"\x0f")
            output.clear()
            count = sum(row["type"] == "custom" for row in records(directory))
            os.write(master, b"\x1b[200~/reload\x1b[201~\r")
            wait(
                lambda: (
                    sum(row["type"] == "start" for row in records(directory)) == 2
                    and "Job render-job" in text()
                )
            )
            assert "JOB_EXPAND_ONLY_DETAIL" not in text(), text()
            assert sum(row["type"] == "custom" for row in records(directory)) == count
            print(
                f"PASS {mode}: agent/job collapsed previews, Ctrl+O expansion, reload without replay"
            )
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
            os.close(master)


if __name__ == "__main__":
    for scenario, count in [("read", 0), ("wait", 1), ("two", 2), ("mixed", 1)]:
        run(scenario, count)
    run("job", 0, job_read=True)
    run("job", 1, job_read=False)
    run("job", 1, job_read=True, abort="continue")
    run("job", 0, job_read=True, abort="close")
    for layout in ["regular", "fullscreen"]:
        tui(layout)
