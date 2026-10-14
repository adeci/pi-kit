"""Offline stock-Pi UI/lifecycle tests. Worker tools are explicit fixture stubs."""

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

source = Path(__file__).resolve().parents[2]
ansi = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")


def run(scenario):
    with tempfile.TemporaryDirectory(prefix="pi-modes-test-") as temporary:
        home = Path(temporary)
        profile = home / "profile"
        discovery = profile / "extensions"
        discovery.mkdir(parents=True)
        for name in ["goal", "director"] + (
            ["handoff"] if scenario == "handoff" else []
        ):
            location = Path(
                os.environ.get(
                    f"PI_{name.upper()}_EXTENSION", source / name / "extension"
                )
            ).resolve()
            (discovery / f"kit-{name}").symlink_to(location)
        (profile / "settings.json").write_text(
            json.dumps(
                {
                    "tuiMode": "regular",
                    "compaction": {"enabled": False, "keepRecentTokens": 64},
                    "retry": {"enabled": False},
                }
            )
        )
        trace = home / "trace.jsonl"
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
        env = dict(
            os.environ,
            HOME=str(home),
            PI_CODING_AGENT_DIR=str(profile),
            PI_MODES_TRACE=str(trace),
            PI_MODES_SCENARIO=scenario,
            PI_HANDOFF_CONFIG=str(home / "handoff.json"),
            PI_SKIP_VERSION_CHECK="1",
        )
        proc = subprocess.Popen(
            [
                os.environ.get("PI_BINARY", "pi"),
                "--provider",
                "modes-fixture",
                "--model",
                "scripted",
                "--thinking",
                "off",
                "-e",
                str(source / "goal/tests/fixture.ts"),
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
            return (
                [
                    json.loads(line)
                    for line in trace.read_text().splitlines()
                    if line.endswith("}")
                ]
                if trace.exists()
                else []
            )

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
                    raise AssertionError(
                        f"Pi exited {proc.returncode}: {text()[-4000:]}"
                    )
                ready, _, _ = select.select([master], [], [], 0.05)
                if ready:
                    output.extend(os.read(master, 65536))
            raise AssertionError(f"{scenario} timed out: {text()[-7000:]}")

        def key(data):
            os.write(master, data)

        def send(message):
            output.clear()
            key(b"\x1b[200~" + message.encode() + b"\x1b[201~\r")

        def pick(query):
            key(query.encode())
            key(b"\r")

        def close_menu():
            previous = count("ui_end")
            key(b"\x1b")
            wait(lambda: count("ui_end") > previous)

        def audit():
            previous = count("audit")
            send("/mode-audit")
            wait(lambda: count("audit") > previous)
            return [record for record in records() if record["event"] == "audit"][-1]

        def goal():
            entries = audit()["entries"]
            return [
                entry["data"]["state"]
                for entry in entries
                if entry["type"] == "custom" and entry["customType"] == "pi-kit:goal:v1"
            ][-1]

        try:
            wait(lambda: count("start") and "scripted" in text())
            original_tools = audit()["tools"]
            if scenario in ["director", "combined"]:
                send("/director")
                wait(lambda: "Director: Off" in text())
                key(b"\r")
                wait(lambda: "Director: On" in text())
                close_menu()
                selected = audit()["tools"]
                assert (
                    "read" in selected
                    and "agent_spawn" in selected
                    and "goal" in selected
                )
                assert not {"bash", "write", "edit"}.intersection(selected)

            if scenario in ["complete", "budget"]:
                send("/goal")
                wait(lambda: "New objective" in text())
                key(b"\r")
                wait(lambda: "Goal objective" in text())
                pick("Verify the fixture objective completely")
                wait(lambda: "State: paused" in text())
                if scenario == "budget":
                    pick("Token budget")
                    wait(lambda: "Goal token budget" in text())
                    pick("100")
                    wait(
                        lambda: (
                            "State: paused" in text()
                            and text().rfind("Goal token budget")
                            < text().rfind("State: paused")
                        )
                    )
                pick("Start")
            elif scenario == "guided":
                send("/guided-goal Test the fixture")
                wait(lambda: count("settled") == 1)
                assert not (home / "interview-executed").exists()
                assert "Guided goal setup is an interview" in json.dumps(records())
                assert not [
                    entry
                    for entry in audit()["entries"]
                    if entry.get("customType") == "pi-kit:goal:v1"
                ]
                send("The scripted check must pass.")
                wait(lambda: "Goal: create?" in text())
                key(b"\r")
            elif scenario == "director":
                send("Direct this fixture workstream")
            else:
                send("/goal Complete the fixture objective")

            if scenario.startswith("wait"):
                wait(lambda: count("request") == 1)
                if scenario == "wait-menu":
                    send("/goal")
                    wait(lambda: "State: active" in text())
                    pick("Pause")
                    wait(lambda: "State: paused" in text())
                    close_menu()
                else:
                    key(b"\x1b")
                wait(lambda: count("settled") == 1)
                paused = goal()["goal"]
                assert paused["status"] == "paused"
                if scenario == "wait-menu":
                    assert paused["tokensUsed"] == 30, paused
                assert any(
                    entry.get("customType") == "pi-kit:goal:mode"
                    and "paused" in entry.get("content", "")
                    for entry in audit()["entries"]
                )
                starts = count("start")
                send("/reload")
                wait(lambda: count("start") > starts and "Reloaded" in text())
                assert goal()["goal"]["status"] == "paused"
                assert count("request") == 1
            elif scenario.startswith("workers"):
                wait(lambda: count("settled") == 1)
                assert count("request") == 1
                assert goal()["goal"]["status"] == "active"
                if scenario == "workers-paused":
                    send("/goal")
                    wait(lambda: "State: active" in text())
                    pick("Pause")
                    wait(lambda: "State: paused" in text())
                    close_menu()
                send("/release-workers")
                wait(lambda: count("settled") == 2)
                assert goal()["goal"]["status"] == (
                    "paused" if scenario == "workers-paused" else "complete"
                )
                if scenario == "workers-paused":
                    request = [r for r in records() if r["event"] == "request"][-1]
                    assert any(
                        "Current goal state: paused" in str(message.get("content", ""))
                        for message in request["context"]["messages"]
                    )
                    assert count("request") == 2
            else:
                wait(lambda: count("settled") == (2 if scenario == "guided" else 1))
                if scenario != "director":
                    state = goal()["goal"]
                    if scenario == "budget":
                        assert state["status"] == "budget-limited", state
                        assert state["tokensUsed"] == 120, state
                        assert count("request") == 2
                    else:
                        assert state["status"] == "complete", (
                            state,
                            [
                                record
                                for record in records()
                                if record["event"] == "status"
                            ][-8:],
                        )
                        assert state["evidence"]
                        if scenario == "handoff":
                            assert count("handoff_request") == 1
                            assert state["tokensUsed"] == 160080, state
                            assert "HANDOFF_EVIDENCE" in json.dumps(
                                [r for r in records() if r["event"] == "request"][1]
                            )
                        if scenario == "guided":
                            assert state["tokensUsed"] == 60, state
                        assert count("request") == (
                            5 if scenario in ["combined", "guided"] else 3
                        )
                if scenario in ["director", "combined"]:
                    assert not (home / "forbidden.txt").exists()
                    workers = [
                        record
                        for record in records()
                        if record["event"] == "worker_tool"
                    ]
                    assert [record["name"] for record in workers] == [
                        "agent_spawn",
                        "agent_assign",
                    ]
                    assert workers[0]["args"]["lifetime"] == "reusable"
                    assert workers[1]["args"]["id"] == "worker-1"
                    send("/director")
                    wait(lambda: "Director: On" in text())
                    key(b"\r")
                    wait(lambda: "Director: Off" in text())
                    close_menu()
                    restored = audit()
                    assert restored["tools"] == original_tools
                    assert any(
                        entry.get("customType") == "pi-kit:director:mode"
                        and "OFF" in entry.get("content", "")
                        for entry in restored["entries"]
                    )
            print(
                json.dumps(
                    {"scenario": scenario, "passed": True, "requests": count("request")}
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


for scenario in [
    "complete",
    "budget",
    "wait",
    "wait-menu",
    "workers",
    "workers-paused",
    "director",
    "combined",
    "handoff",
    "guided",
]:
    run(scenario)
