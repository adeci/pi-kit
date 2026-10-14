"""Offline installed-Pi test; no credentials or network access required."""

import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

source = Path(__file__).resolve().parents[1]
ansi = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")
with tempfile.TemporaryDirectory(prefix="pi-handoff-test-") as temporary:
    home = Path(temporary)
    profile = home / "profile"
    discovery = profile / "extensions"
    discovery.mkdir(parents=True)
    extension = Path(
        os.environ.get("PI_HANDOFF_EXTENSION", source / "extension")
    ).resolve()
    (discovery / "kit-handoff").symlink_to(extension)
    (profile / "settings.json").write_text(
        json.dumps(
            {
                "tuiMode": "regular",
                "compaction": {"enabled": False, "keepRecentTokens": 64},
            }
        )
    )
    trace = home / "trace.jsonl"
    config = home / "handoff.json"
    mode = home / "mode"
    mode.write_text("ok")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
    env = dict(
        os.environ,
        HOME=str(home),
        PI_CODING_AGENT_DIR=str(profile),
        PI_HANDOFF_TRACE=str(trace),
        PI_HANDOFF_MODE=str(mode),
        PI_HANDOFF_CONFIG=str(config),
        PI_SKIP_VERSION_CHECK="1",
    )
    proc = subprocess.Popen(
        [
            os.environ.get("PI_BINARY", "pi"),
            "--provider",
            "handoff-fixture",
            "--model",
            "working",
            "--thinking",
            "off",
            "-e",
            str(source / "tests/fixture.ts"),
        ],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        cwd=home,
        env=env,
        start_new_session=True,
    )
    os.close(slave)
    output = bytearray()

    def records():
        if not trace.exists():
            return []
        return [
            json.loads(line)
            for line in trace.read_text().splitlines()
            if line.endswith("}")
        ]

    def count(event):
        return sum(record["event"] == event for record in records())

    def text():
        return ansi.sub(b"", output).decode("utf8", "replace")

    def wait(predicate):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if predicate():
                return
            if proc.poll() is not None:
                raise AssertionError(f"Pi exited {proc.returncode}: {text()[-4000:]}")
            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                output.extend(os.read(master, 65536))
        raise AssertionError(f"Timed out: {text()[-6000:]}")

    def send(message):
        output.clear()
        os.write(master, b"\x1b[200~" + message.encode() + b"\x1b[201~\r")

    def audit():
        previous = count("context")
        send("/handoff-audit")
        wait(lambda: count("context") > previous)
        return [record for record in records() if record["event"] == "context"][-1]

    def key(data):
        os.write(master, data)

    def picker(query):
        key(query.encode())
        key(b"\r")

    def menu():
        send("/handoff")
        wait(lambda: "Handoff settings" in text())

    def close_menu():
        previous = count("ui_end")
        key(b"\x1b")
        wait(lambda: count("ui_end") > previous)

    def prompt(message):
        baseline = count("settled")
        send(message)
        wait(lambda: count("settled") > baseline)

    def compactions():
        return [entry for entry in audit()["entries"] if entry["type"] == "compaction"]

    try:
        wait(lambda: count("start") and "working" in text())
        assert records()[0]["commands"].count("handoff") == 1
        menu()
        picker("Summarizer")
        wait(lambda: "Handoff summarizer model" in text())
        picker("summary")
        wait(
            lambda: (
                config.exists()
                and json.loads(config.read_text()).get("model", {}).get("id")
                == "summary"
            )
        )
        wait(
            lambda: (
                "handoff-fixture/summary" in text()
                and text().rfind("Handoff settings")
                > text().rfind("Handoff summarizer model")
            )
        )
        picker("Context threshold")
        wait(lambda: "Handoff context threshold" in text())
        picker("75")
        wait(lambda: json.loads(config.read_text()).get("threshold") == 75)
        wait(lambda: "Context threshold: 75%" in text())
        for value in ["", "0", "100", "80.5", "garbage", None, "1", "99%", "75"]:
            before = config.read_bytes()
            output.clear()
            picker("Context threshold")
            wait(lambda: "Handoff context threshold" in text())
            key(b"\x1b" if value is None else value.encode() + b"\r")
            wait(
                lambda: (
                    text().rfind("Handoff settings")
                    > text().rfind("Handoff context threshold")
                )
            )
            if value in ("1", "99%", "75"):
                assert json.loads(config.read_text())["threshold"] == int(
                    value.rstrip("%")
                )
            else:
                assert config.read_bytes() == before, (
                    f"Invalid input changed settings: {value!r}"
                )
        close_menu()
        audit()

        prompt("EARLY_ONLY " + "historical detail " * 1500)
        prompt("INTERMEDIATE_WORK " + "middle " * 60)
        prompt("BELOW")
        assert not compactions()
        before = audit()
        session = Path(
            next(record["file"] for record in records() if record["event"] == "start")
        )
        original = session.read_text().splitlines()
        baseline = count("request")
        prompt("RUN automatic handoff")
        after = audit()
        saved = [entry for entry in after["entries"] if entry["type"] == "compaction"]
        assert len(saved) == 1
        assert saved[0]["usage"]["totalTokens"] == 10
        assert saved[0]["details"]["model"]["id"] == "summary"
        assert session.read_text().splitlines()[: len(original)] == original
        calls = [r for r in records() if r["event"] == "request"][baseline:]
        assert [r["model"] for r in calls] == ["working", "summary", "working"], calls
        resumed = json.dumps(calls[-1]["context"])
        assert "HANDOFF_EVIDENCE" in resumed and "TOOL_EVIDENCE" in resumed
        assert "EARLY_ONLY" not in resumed
        assert "EARLY_ONLY" in json.dumps(calls[1]["context"])
        assert calls[-1]["context"]["messages"][-1]["role"] == "toolResult"
        # The call/result pair stays intact across the cut.
        assert any(
            part.get("type") == "toolCall"
            for message in calls[-1]["context"]["messages"]
            for part in (
                message.get("content", [])
                if isinstance(message.get("content"), list)
                else []
            )
        )

        for failure in ["empty", "error", "wait"]:
            mode.write_text(failure)
            baseline = count("request")
            settled = count("settled")
            send("RUN " + failure)
            if failure == "wait":
                wait(lambda base=baseline: count("request") >= base + 2)
                key(b"\x1b")
            wait(lambda base=settled: count("settled") > base)
            assert len(compactions()) == 1
            calls = [r for r in records() if r["event"] == "request"][baseline:]
            assert [r["model"] for r in calls] == ["working", "summary"]
            mode.write_text("ok")

        baseline = count("request")
        prompt("RUN repeated automatic handoff")
        assert len(compactions()) == 2
        calls = [r for r in records() if r["event"] == "request"][baseline:]
        assert [r["model"] for r in calls] == ["working", "summary", "working"]
        assert "HANDOFF_EVIDENCE" in json.dumps(calls[1]["context"])
        assert "EARLY_ONLY" not in json.dumps(calls[1]["context"])
        assert "EARLY_ONLY" not in json.dumps(calls[-1]["context"])

        # Native /compact also uses the selected summarizer and native Escape.
        baseline = count("request")
        mode.write_text("wait")
        send("/compact")
        wait(lambda: count("request") > baseline)
        key(b"\x1b")
        wait(lambda: "cancelled" in text().lower())
        assert len(compactions()) == 2
        mode.write_text("ok")
        previous = count("compact")
        send("/compact")
        wait(lambda: count("compact") > previous and "Compacted" in text())
        assert len(compactions()) == 3

        menu()
        picker("Automatic handoff")
        wait(lambda: json.loads(config.read_text()).get("enabled") is False)
        wait(lambda: "Automatic handoff: Off" in text())
        close_menu()
        audit()
        prompt("RUN disabled")
        assert len(compactions()) == 3
        starts = count("start")
        send("/reload")
        wait(lambda: count("start") > starts and "Reloaded" in text())
        assert [r for r in records() if r["event"] == "start"][-1]["commands"].count(
            "handoff"
        ) == 1
        prompt("RUN still disabled after reload")
        assert len(compactions()) == 3
        assert json.loads(config.read_text())["threshold"] == 75
        print(
            json.dumps(
                {
                    "settings_popup": True,
                    "exact_summarizer_model": True,
                    "threshold": True,
                    "automatic_continuation": True,
                    "retained_tool_pair": True,
                    "transcript_preserved": True,
                    "failure_stops_work": True,
                    "escape": True,
                    "native_compaction": True,
                    "disable_and_reload": True,
                    "discovery": True,
                }
            )
        )
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
        os.close(master)
