"""Offline installed-Pi UI checks for status, quotas, resize and named waits."""

import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[2]
PI = os.environ.get("PI_BINARY", "pi")
ANSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")


def run(mode, delayed=False, auth="both"):
    with tempfile.TemporaryDirectory(prefix="kit-status-test-") as tmp:
        home = Path(tmp)
        profile = home / "profile"
        (profile / "extensions").mkdir(parents=True)
        for component in ["status", "usage", "events"]:
            path = Path(
                os.environ.get(
                    f"PI_{component.upper()}_EXTENSION",
                    SOURCE / component / "extension",
                )
            ).resolve()
            (profile / "extensions" / f"kit-{component}").symlink_to(path)
        (profile / "settings.json").write_text(
            json.dumps(
                {
                    "tuiMode": mode,
                    "theme": "dark",
                    "retry": {"enabled": False},
                    "compaction": {"enabled": False},
                }
            )
        )
        trace = home / "trace"
        (home / "run").mkdir()
        registry = home / "state/pi-kit/events/names.json"

        def subscriptions():
            result = []
            for path in (home / "run/pi-events").glob("*.json"):
                try:
                    result.append(json.loads(path.read_text()))
                except FileNotFoundError:
                    pass  # Shutdown can unlink a subscription after glob finds it.
            return result

        cli = (
            [os.environ["PI_EVENTS_BINARY"]]
            if "PI_EVENTS_BINARY" in os.environ
            else [sys.executable, str(SOURCE / "events/events.py")]
        )
        env = {
            **os.environ,
            "HOME": str(home),
            "XDG_STATE_HOME": str(home / "state"),
            "XDG_RUNTIME_DIR": str(home / "run"),
            "PI_CODING_AGENT_DIR": str(profile),
            "PI_UI_TRACE": str(trace),
            "PI_SKIP_VERSION_CHECK": "1",
            "PI_UI_AUTH": auth,
            "PI_UI_SLOW": "1",
        }
        if delayed:
            env["PI_UI_DELAY"] = "1"
        args = [
            PI,
            "--offline",
            "--provider",
            "ui-fixture",
            "--model",
            "scripted",
            "--thinking",
            "off",
            "-e",
            str(SOURCE / "status/tests/fixture.ts"),
        ]
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 42, 180, 0, 0))
        proc = subprocess.Popen(
            args,
            cwd=home,
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

        def records(event):
            return (
                [
                    row
                    for row in (
                        json.loads(line)
                        for line in trace.read_bytes().split(b"\n")[:-1]
                    )
                    if row["event"] == event
                ]
                if trace.exists()
                else []
            )

        def wait(predicate):
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if predicate():
                    return
                assert proc.poll() is None, text()[-8000:]
                ready, _, _ = select.select([master], [], [], 0.05)
                if ready:
                    output.extend(os.read(master, 65536))
            raise AssertionError(f"{mode}/{delayed}: {text()[-10000:]}")

        def key(value):
            output.clear()
            os.write(master, value)

        def send(value):
            key(b"\x1b[200~" + value.encode() + b"\x1b[201~\r")

        def resize(columns):
            output.clear()
            fcntl.ioctl(
                master, termios.TIOCSWINSZ, struct.pack("HHHH", 42, columns, 0, 0)
            )
            os.kill(proc.pid, signal.SIGWINCH)

        try:
            wait(
                lambda: (
                    records("start")
                    and "UI fixture" in text()
                    and "Other extension status" in text()
                )
            )
            wait(lambda: subscriptions() and subscriptions()[0].get("name"))
            owner = subscriptions()[0]["session"]
            send("/events rename Miso")
            wait(lambda: subscriptions()[0].get("name") == "miso" and "miso" in text())
            assert json.loads(registry.read_text())[owner] == "miso"
            helper = (profile / "extensions/kit-events").resolve().parent / "names.py"
            subprocess.run(
                [sys.executable, str(helper), "other-session", "otter"],
                env=env,
                check=True,
                capture_output=True,
            )
            send("/events rename otter")
            wait(lambda: "already reserved" in text())
            assert subscriptions()[0]["name"] == "miso"
            send("Inspect the named wait")
            wait(
                lambda: (
                    records("settled")
                    and "STATUS_USAGE_COMPLETE" in text()
                    and "$0.80" in text()
                )
            )
            assert "memory-research" in text() and "29844f553aa83c01" in text(), text()
            assert "EXPANDED_EVIDENCE_" not in text(), text()
            assert "$0.80" in text(), text()
            wait(lambda: "Working" in text())
            assert "cache read" not in text(), text()
            key(b"\x0f")
            wait(lambda: "EXPANDED_EVIDENCE_" in text())
            key(b"\x0f")
            send("/usage")
            count = 2 if auth == "both" else 1 if auth == "codex" else 0
            wait(lambda: len(records("quota")) == count and records("frame"))
            if delayed:
                before = len(records("ui_end"))
                key(b"\x1b")
                wait(
                    lambda: (
                        len(records("ui_end")) > before
                        and len(records("quota_aborted")) == 2
                    )
                )
                print(f"PASS {mode}: closing cancels both quota requests")
                return
            if not count:
                wait(lambda: "No logged-in subscriptions" in text())
                assert "OpenAI Codex" not in text() and "Anthropic Claude" not in text()
            else:
                # A PTY read may end halfway through the frame. Wait for every
                # expected provider/credit field, not just the first meter.
                wait(
                    lambda: (
                        "80% remaining" in text()
                        and "20% used" in text()
                        and "OpenAI Codex" in text()
                        and "61,283.92" in text()
                        and (auth != "both" or "Anthropic Claude" in text())
                    )
                )
                assert "OpenAI Codex" in text() and "61,283.92" in text(), text()
                assert ("Anthropic Claude" in text()) == (auth == "both"), text()
                # No keys: a changing clock must produce real terminal output, not just mutate state.
                output.clear()
                wait(lambda: "checked 2s ago" in text())
                assert len(records("quota")) == count
            for columns in [75, 40, 100, 180]:
                resize(columns)
                wait(lambda columns=columns: records("frame")[-1]["columns"] == columns)
                frame = records("frame")[-1]
                assert frame["layout"], frame
                box = frame["layout"][-1]
                assert abs(box["row"] - (frame["rows"] - box["height"]) / 2) <= 1, frame
                assert abs(box["col"] - (columns - box["width"]) / 2) <= 1, frame
            key(b"r")
            wait(
                lambda: (
                    ("Using cached results" if count else "Refresh complete") in text()
                )
            )
            before = len(records("ui_end"))
            key(b"\x1b")
            wait(lambda: len(records("ui_end")) > before)
            assert len(records("quota")) == count
            resize(60)
            wait(lambda: "Subagents" in text())
            resize(180)
            wait(lambda: "memory-research ⟨reviewer⟩" in text())
            send("/status ascii")
            wait(lambda: "UI fixture" in text() and " | " in text())
            send("/fixture-theme")
            wait(lambda: records("theme") and "UI fixture" in text())
            send("/status off")
            wait(lambda: "R4.0k" in text())
            assert "cache read" not in text(), text()
            settled = len(records("settled"))
            send("Check restored working indicator")
            wait(lambda: "Working" in text())
            wait(lambda: len(records("settled")) > settled)
            send("/status on")
            wait(lambda: "UI fixture" in text() and "Other extension status" in text())
            old_attachment = subscriptions()[0]["id"]
            send("/reload")
            wait(
                lambda: (
                    subscriptions()
                    and subscriptions()[0]["id"] != old_attachment
                    and subscriptions()[0].get("name") == "miso"
                )
            )
            assert json.loads(registry.read_text())[owner] == "miso"
            before = len(records("settled"))
            output.clear()
            result = subprocess.run(
                [*cli, "send", "miso"],
                input="NAMED_EVENT_DELIVERY\n",
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            assert result.returncode == 0, result.stderr
            assert json.loads(result.stdout)["accepted"] == 1, result.stdout
            wait(lambda: len(records("settled")) > before and records("named_input"))
            assert "miso" in text(), text()
            key(b"\x04")
            wait(lambda: not subscriptions())
            assert json.loads(registry.read_text())[owner] == "miso"
            result = subprocess.run(
                [*cli, "send", "miso"],
                input="OFFLINE\n",
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            assert result.returncode != 0 and "offline" in result.stderr, result
            print(
                f"PASS {mode}/{auth}: footer, quotas, cache, name/rename, named idle wake, offline refusal and cleanup"
            )
        finally:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait(timeout=5)
            os.close(master)


if __name__ == "__main__":
    run("regular")
    run("fullscreen")
    run("regular", delayed=True)
    run("regular", auth="codex")
    run("fullscreen", auth="none")
