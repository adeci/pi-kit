"""Offline real-TUI smoke: live widget, inspector views, resize and branch stop."""

import fcntl
import json
import os
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PI = os.environ.get("PI_BINARY", shutil.which("pi"))
EXTENSION = os.environ.get("PI_AGENTS_TEST_EXTENSION", str(ROOT / "extension/index.ts"))
FIXTURE = ROOT / "tests/fixture.ts"
ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")


def main():
    with tempfile.TemporaryDirectory(prefix="pa-ui-", dir="/tmp") as temporary:
        directory = Path(temporary)
        for name in ("home", "profile", "run", "state", "repo"):
            (directory / name).mkdir(mode=0o700)
        config = directory / "config.json"
        config.write_text(
            json.dumps(
                {
                    "roles": {
                        "reviewer": {
                            "model": "pi-agents-fixture/scripted",
                            "extensions": [str(FIXTURE)],
                        },
                        **{
                            f"role{i:02}": {"prompt": "UI viewport fixture"}
                            for i in range(12)
                        },
                    },
                }
            )
        )
        env = {
            key: value
            for key, value in os.environ.items()
            if key in {"PATH", "SHELL", "LANG", "LC_ALL", "TMPDIR", "SSL_CERT_FILE"}
        }
        env.update(
            {
                "HOME": str(directory / "home"),
                "PI_CODING_AGENT_DIR": str(directory / "profile"),
                "XDG_RUNTIME_DIR": str(directory / "run"),
                "PI_AGENTS_CONFIG": str(config),
                "PI_AGENTS_STATE_DIR": str(directory / "state"),
                "PI_AGENTS_TEST_READY": str(directory / "ready"),
                "PI_AGENTS_TEST_UI_LOG": str(directory / "ui.log"),
                "PI_AGENTS_TEST_WIDGET_LOG": str(directory / "widget.log"),
                "TERM": "xterm-256color",
                "PI_OFFLINE": "1",
            }
        )
        discovery = directory / "profile/extensions"
        discovery.mkdir(parents=True)
        (discovery / "kit-agents").symlink_to(
            Path(EXTENSION).parent, target_is_directory=True
        )
        (discovery / "kit-todos").symlink_to(
            Path(
                os.environ.get(
                    "PI_TODOS_TEST_EXTENSION",
                    str(ROOT.parent / "todos/extension/index.ts"),
                )
            ).parent,
            target_is_directory=True,
        )
        suite = os.environ.get("PI_KIT_TEST_SUITE")
        if suite:
            for name in ("jobs", "events", "handoff", "goal", "director", "ask"):
                (discovery / f"kit-{name}").symlink_to(
                    Path(suite) / "share/pi-kit" / name / "extension",
                    target_is_directory=True,
                )
            # Deterministic CLI fixture for menu rendering; actual Pueue behavior
            # is covered by the jobs lifecycle/integration tests.
            jobs_fixture = directory / "jobs-fixture"
            jobs_fixture.write_text(
                '#!/usr/bin/env python3\nimport json,sys\nif sys.argv[1] == "status": print(json.dumps([{"handle":"1:"+"a"*32,"name":"Fixture build","state":"success"}]))\nelif sys.argv[1] == "health": print(json.dumps({"callback_verified":False}))\nelif sys.argv[1] == "log": print("Fixture log output")\nelse: raise SystemExit(1)\n'
            )
            jobs_fixture.chmod(0o700)
            env["PI_JOBS_BIN"] = str(jobs_fixture)
            env["PI_EVENTS_BIN"] = str(Path(suite) / "bin/pi-events")
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 100, 0, 0))
        process = subprocess.Popen(
            [
                PI,
                "--offline",
                "--no-skills",
                "--no-prompt-templates",
                "--no-themes",
                "--no-context-files",
                "-e",
                str(FIXTURE),
                "--model",
                "pi-agents-fixture/scripted",
            ],
            cwd=directory / "repo",
            env=env,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        os.close(slave)
        output = bytearray()

        def pump():
            if select.select([master], [], [], 0.05)[0]:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    pass

        def wait(predicate, timeout=20):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                pump()
                if predicate():
                    return
                if process.poll() is not None:
                    break
            raise AssertionError(
                ANSI.sub("", output.decode("utf8", "replace"))[-12000:]
            )

        def text():
            return ANSI.sub("", output.decode("utf8", "replace"))

        def agent():
            files = list((directory / "state").glob("*/agents.json"))
            if not files:
                return None
            agents = json.loads(files[0].read_text())["agents"]
            return agents[0] if agents else None

        try:
            wait(lambda: (directory / "ready").exists() and "scripted" in text())
            os.write(
                master,
                b'CONTROL {"operation":"todo","args":{"op":"init","items":["Inspect UI","Validate result"]}}\r',
            )
            wait(lambda: "0/2 completed" in text())
            os.write(master, b"/todos\r")
            wait(lambda: "s start" in text())
            os.write(master, b"s")
            wait(lambda: "1 active" in text())
            os.write(master, b"d")
            wait(lambda: "1/2 completed" in text())
            os.write(master, b"\x1b[Bd")
            wait(lambda: "2/2 completed" in text())
            os.write(master, b"\x1b")
            todo_log = directory / "widget.log.todos"
            wait(
                lambda: (
                    todo_log.exists()
                    and json.loads(todo_log.read_text().splitlines()[-1])["event"]
                    == "clear"
                ),
                timeout=8,
            )
            os.write(master, b"/todos\r")
            time.sleep(0.1)
            pump()
            os.write(master, b"s")
            wait(
                lambda: (
                    json.loads(todo_log.read_text().splitlines()[-1])["event"]
                    == "mount"
                )
            )
            os.write(master, b"\x1b")
            time.sleep(0.1)
            os.write(master, b"/kit\r")
            wait(
                lambda: (
                    "pi-kit health" in text()
                    and ("Agents: attached" if suite else "not loaded") in text()
                )
            )
            if suite:
                wait(
                    lambda: (
                        "Events: live attachment" in text() and "Jobs: loaded" in text()
                    )
                )
            assert "[Recovery]" not in text()
            if suite:
                os.write(master, b"/jobs\r")
                wait(lambda: "Fixture build" in text())
                os.write(master, b"\r")
                wait(lambda: "Job actions" in text() and "Watch" in text())
                os.write(master, b"\r")
                wait(lambda: "Fixture log output" in text())
            # The existing inspector mount assertions count only agent menus.
            (directory / "ui.log").write_text("")
            # Do not answer terminal capability queries; exercise Pi's fallback.
            time.sleep(0.4)
            os.write(
                master,
                (
                    'CONTROL {"operation":"spawn","args":{"task":"SCENARIO hang","role":"reviewer","name":"Reviewer 測試"}}\r'
                ).encode(),
            )
            wait(lambda: agent() and (directory / "repo" / "shell.pid").exists())
            wait(lambda: "Subagents" in text() and "turns" in text())
            secondary = directory / "second-repo"
            secondary.mkdir()
            os.write(
                master,
                (
                    "CONTROL "
                    + json.dumps(
                        {
                            "operation": "spawn",
                            "args": {
                                "task": "SCENARIO hang",
                                "role": "reviewer",
                                "name": "Scout",
                                "cwd": str(secondary),
                            },
                        }
                    )
                    + "\r"
                ).encode(),
            )
            wait(lambda: "2 active" in text() and (secondary / "shell.pid").exists())
            records = [
                json.loads(line)
                for line in (directory / "widget.log").read_text().splitlines()
            ]
            mounts = [record for record in records if record["event"] == "mount"]
            assert mounts == [{"event": "mount", "placement": "aboveEditor"}]
            previews = [
                record
                for record in records
                if record["event"] == "render" and record["lines"]
            ]
            assert previews
            assert all(
                all(size <= record["width"] for size in record["widths"])
                for record in previews
            )
            preview = ANSI.sub("", "\n".join(previews[-1]["lines"]))
            assert "Reviewer 測試" in preview and "└─" in preview and "Scout" in preview
            assert agent()["id"] not in preview
            assert "pi-agents-fixture/" not in preview
            assert "│  ↳" in preview
            os.write(master, b"/agents\r")
            wait(
                lambda: (
                    "Live conversation" in text() and "╭" in text() and "╰" in text()
                )
            )
            wait(lambda: "Working" in text())
            wait(lambda: "Inspecting the live agent stream" in text())
            assert "[Details]" not in text()
            assert all(junction in text() for junction in ("┬", "┼", "┴"))
            os.write(master, b"\x1b[B")
            wait(lambda: "Live conversation · Scout" in text())
            os.write(master, b"\x1b[A")
            time.sleep(0.1)
            pump()
            os.write(master, b"\x1b[5~")
            wait(lambda: "paused" in text())
            os.write(master, b"\x1b[F")
            os.write(master, b"\t")
            wait(lambda: "[History]" in text() and "No inactive agents" in text())
            os.write(master, b"\t")
            wait(
                lambda: (
                    "[Settings]" in text()
                    and "Task agent" in text()
                    and "Role11 agent" in text()
                )
            )
            assert "Task model" not in text()
            os.write(master, b"role11")
            time.sleep(0.1)
            pump()
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 20, 42, 0, 0))
            time.sleep(0.1)
            pump()
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 100, 0, 0))
            time.sleep(0.1)
            pump()
            os.write(master, b"\r")
            wait(lambda: "Settings › Role11 agent" in text())
            os.write(master, b"\x1b")
            time.sleep(0.1)
            os.write(master, b"\x1b")
            time.sleep(0.1)
            os.write(master, b"task agent")
            time.sleep(0.1)
            pump()
            assert (directory / "ui.log").read_text().splitlines() == ["open"]
            os.write(master, b"\r")
            wait(lambda: "Settings › Task agent" in text())
            os.write(master, b"\r")
            wait(lambda: "Settings › Task agent › Model" in text())
            os.write(master, b"\x1b")
            time.sleep(0.1)
            pump()
            assert (directory / "ui.log").read_text().splitlines() == ["open"]
            os.write(master, b"\r")
            time.sleep(0.1)
            pump()
            os.write(master, b"scripted")
            wait(lambda: "scripted" in text())
            os.write(master, b"\r")
            wait(
                lambda: (
                    json.loads(config.read_text())
                    .get("roles", {})
                    .get("task", {})
                    .get("model")
                    == "pi-agents-fixture/scripted"
                )
            )
            assert json.loads(config.read_text())["roles"]["reviewer"][
                "extensions"
            ] == [str(FIXTURE)]
            assert (
                json.loads(config.read_text())["roles"]["reviewer"]["model"]
                == "pi-agents-fixture/scripted"
            )
            os.write(master, b"\x1b[B\r")
            wait(lambda: "Settings › Task agent › Thinking" in text())
            os.write(master, b"\x1b[B\r")
            wait(
                lambda: (
                    json.loads(config.read_text())
                    .get("roles", {})
                    .get("task", {})
                    .get("thinking")
                    == "high"
                )
            )
            os.write(master, b"\x1b[B\r")
            wait(lambda: "Settings › Task agent › Limits" in text())
            os.write(master, b"\r")
            wait(lambda: "Request guard" in text())
            os.write(master, b"\x1b")
            time.sleep(0.1)
            os.write(master, b"\x1b")
            time.sleep(0.1)
            os.write(master, b"\x1b")
            time.sleep(0.1)
            pump()
            assert (directory / "ui.log").read_text().splitlines() == ["open"]
            os.write(master, b"\t")
            wait(lambda: "[Active]" in text())
            for key, label in (
                (b"1", "Live conversation"),
                (b"4", "Prompt"),
                (b"2", "Result"),
            ):
                os.write(master, key)
                wait(lambda label=label: label in text())
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 20, 42, 0, 0))
            time.sleep(0.1)
            os.write(master, b"1")
            pump()
            os.write(master, b"x")
            wait(lambda: agent()["assignments"][-1]["state"] == "cancelled")
            # stop() settles before the inspector is remounted; do not send Tab into that gap.
            wait(lambda: "Active · 1 agents" in text())
            os.write(master, b"\t")
            wait(lambda: "[History]" in text() and "History · 1 in session" in text())
            os.write(master, b"\x1b")
            time.sleep(0.2)
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 100, 0, 0))
            time.sleep(0.1)
            os.write(master, b"/kit\r")
            wait(lambda: "pi-kit health" in text())
            time.sleep(0.2)
            pump()
            assert agent()["assignments"][-1]["state"] == "cancelled"
            os.write(master, b"/reload\r")
            time.sleep(0.5)
            pump()
            output.clear()
            os.write(master, b"/todos\r")
            wait(lambda: "1/2 completed" in text() and "Validate result" in text())
            os.write(master, b"\x1b")
            time.sleep(0.1)
            os.write(master, b"/agents\r")
            wait(lambda: "[Active]" in text())
            os.write(master, b"\x1b")
            time.sleep(0.2)
            os.write(master, b"\x04")
            wait(lambda: process.poll() is not None)
            assert process.returncode == 0, text()
            assert "TypeError" not in text() and "rendered line" not in text(), text()
            print(
                json.dumps(
                    {
                        "tui": True,
                        "widget": True,
                        "anchored_hud": True,
                        "width_safe_hud": True,
                        "multiple_agent_hud": True,
                        "inspector": True,
                        "split_inspector": True,
                        "active_and_session_history": True,
                        "todos_tool_and_menu": True,
                        "working_indicator": True,
                        "thinking_visible": True,
                        "todos_reload": True,
                        "completed_todos_auto_hide": True,
                        "discovered_symlink_extensions": True,
                        "read_only_health_report": True,
                        "continuous_hud_tree": True,
                        "tabs": True,
                        "model_picker_saved": True,
                        "bordered_overlay": True,
                        "searchable_model_picker": True,
                        "persistent_submenus": True,
                        "grouped_roles": True,
                        "combined_model_controls": True,
                        "full_height_settings": True,
                        "settings_resize_preserves_search": True,
                        "reload": True,
                        "views": True,
                        "narrow_resize": True,
                        "stop_branch": True,
                    }
                )
            )
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)
            os.close(master)


if __name__ == "__main__":
    main()
