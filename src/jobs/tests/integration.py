#!/usr/bin/env python3
"""Offline Pi integration: live events, durable jobs, and no offline replay."""

import json
import os
import queue
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PI = os.environ.get("PI_BINARY", shutil.which("pi"))
CLI = os.environ.get("PI_JOBS_TEST_BIN", str(ROOT / "target/debug/pi-jobs"))
EXTENSION = os.environ.get("PI_JOBS_EXTENSION", str(ROOT / "extension/index.ts"))
EVENTS_EXTENSION = os.environ.get(
    "PI_EVENTS_EXTENSION", str(ROOT.parent / "events/extension/index.ts")
)
EVENTS_CLI = os.environ.get("PI_EVENTS_TEST_BIN", str(ROOT.parent / "events/events.py"))


def until(predicate, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError("Timed out waiting for fixture")


class Pi:
    def __init__(self, env, root, log, session_id=None):
        ready = root / "ready.json"
        ready.unlink(missing_ok=True)
        self.log = log
        args = [
            PI,
            "--offline",
            "--mode",
            "rpc",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "-e",
            EVENTS_EXTENSION,
            "-e",
            EXTENSION,
            "-e",
            str(ROOT / "tests/fixtures/canned-provider.ts"),
            "--provider",
            "pi-jobs-fixture",
            "--model",
            "canned",
            "--session-dir",
            str(root / "sessions"),
        ]
        if session_id:
            args.extend(["--session-id", session_id])
        self.process = subprocess.Popen(
            args,
            cwd=root,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=log,
            text=True,
        )
        self.events = queue.Queue()
        self.seen = []
        threading.Thread(target=self.read, daemon=True).start()
        try:
            until(lambda: ready.exists() or self.process.poll() is not None)
            assert self.process.poll() is None
            self.attachment = json.loads(ready.read_text())
            assert self.attachment.get("subscription"), "Events attachment failed"
        except Exception as error:
            log.seek(0)
            message = log.read()
            self.close()
            raise AssertionError(message) from error

    def read(self):
        for line in self.process.stdout:
            try:
                self.events.put(json.loads(line))
            except json.JSONDecodeError:
                pass

    def send(self, command):
        self.process.stdin.write(json.dumps(command) + "\n")
        self.process.stdin.flush()

    def receive(self, predicate, seconds=10):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                event = self.events.get(timeout=0.1)
            except queue.Empty:
                continue
            self.seen.append(event)
            if predicate(event):
                return event
        self.log.flush()
        self.log.seek(0)
        raise AssertionError(
            f"No expected RPC event; stderr={self.log.read()}; events={self.seen}"
        )

    def notices(self):
        entries = [
            json.loads(line)
            for line in Path(self.attachment["session"]).read_text().splitlines()
        ]
        return [
            entry
            for entry in entries
            if entry.get("type") == "custom_message"
            and entry.get("customType") == "pi-events"
        ]

    def close(self, sig=signal.SIGTERM):
        if self.process.poll() is None:
            self.process.send_signal(sig)
            self.process.wait(timeout=10)
        if self.process.stdin:
            self.process.stdin.close()


def main():
    assert PI, "Pi must be installed, or set PI_BINARY"
    with tempfile.TemporaryDirectory(prefix="pk-", dir="/tmp") as temporary:
        root = Path(temporary)
        env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith(("PI_JOBS_", "PI_EVENTS_")) and key != "PI_SESSION_ID"
        }
        env.update(
            {
                "PI_CODING_AGENT_DIR": str(root / "agent"),
                "XDG_RUNTIME_DIR": str(root / "run"),
                "XDG_STATE_HOME": str(root / "state"),
                "PI_JOBS_CONFIG": str(root / "pueue.yml"),
                "PI_JOBS_FIXTURE_READY": str(root / "ready.json"),
                "PI_OFFLINE": "1",
                "PI_TELEMETRY": "0",
            }
        )
        # Source tests override binary lookup; packaged tests exercise installed lookup.
        trace = None
        if "PI_JOBS_EXTENSION" not in os.environ:
            trace = root / "observer-calls"
            wrapper = root / "observer-cli"
            wrapper.write_text(
                f'#!{shutil.which("bash")}\nprintf "%s\\n" "$*" >> "$PI_JOBS_TEST_TRACE"\nexec "$PI_JOBS_TEST_REAL_BIN" "$@"\n'
            )
            wrapper.chmod(0o700)
            env.update(
                {
                    "PI_JOBS_BIN": str(wrapper),
                    "PI_JOBS_TEST_TRACE": str(trace),
                    "PI_JOBS_TEST_REAL_BIN": CLI,
                }
            )
        if "PI_EVENTS_EXTENSION" not in os.environ:
            env["PI_EVENTS_BIN"] = EVENTS_CLI
        env["PATH"] = str(Path(CLI).parent) + os.pathsep + env["PATH"]
        subprocess.run(
            [CLI, "init", "--callbacks"], env=env, check=True, capture_output=True
        )
        with (
            open(root / "daemon.log", "w+") as daemon_log,
            open(root / "pi.stderr", "a+") as pi_log,
        ):
            daemon = subprocess.Popen(
                ["pueued", "--config", env["PI_JOBS_CONFIG"]],
                env={**env, "PI_EVENTS_BIN": EVENTS_CLI},
                stdout=daemon_log,
                stderr=subprocess.STDOUT,
            )
            pi = None
            try:
                until(lambda: (root / "run/pi-jobs/pueue/socket").exists())
                subprocess.run(
                    [CLI, "doctor"], env=env, check=True, capture_output=True
                )
                pi = Pi(env, root, pi_log)
                pi.send(
                    {"type": "prompt", "message": "Establish the offline conversation"}
                )
                pi.receive(lambda event: event.get("type") == "agent_end")
                owner = pi.attachment["owner"]
                attached = {
                    **env,
                    "PI_JOBS_SESSION": owner,
                    "PI_EVENTS_SESSION": owner,
                    "PI_EVENTS_SUBSCRIPTION": pi.attachment["subscription"],
                }
                # The test publisher itself always uses an explicit binary.
                attached["PI_EVENTS_BIN"] = EVENTS_CLI

                def submit(command, check_in=None):
                    arguments = [CLI, "run", "--detach", "--name", "integration"]
                    if check_in is not None:
                        arguments.extend(["--check-in", str(check_in)])
                    result = subprocess.run(
                        arguments,
                        env=attached,
                        input=command,
                        capture_output=True,
                        text=True,
                        check=True,
                    )
                    assert "could not attach" not in result.stderr, result.stderr
                    return re.search(r"job=(\d+:[a-f0-9]{32})", result.stdout)[1]

                first = submit(
                    "sleep 3; printf '%8192s\\n' ''; echo integration-complete\n"
                )
                pi.send({"type": "get_state", "id": "responsive"})
                assert pi.receive(lambda event: event.get("id") == "responsive", 2)[
                    "success"
                ]
                if trace:
                    time.sleep(1.3)
                    assert len(trace.read_text().splitlines()) == 1, trace.read_text()
                pi.receive(lambda event: event.get("type") == "agent_end")
                notices = pi.notices()
                assert len(notices) == 1 and first in notices[0]["content"], notices
                assert "integration-complete" in notices[0]["content"]
                second = submit("sleep 2; echo survived-pi-exit\n")
                pi.close(signal.SIGKILL)
                time.sleep(3)
                pi = Pi(env, root, pi_log, owner)
                pi.send({"type": "get_state", "id": "reopened"})
                pi.receive(lambda event: event.get("id") == "reopened")
                time.sleep(2.2)
                assert (
                    pi.attachment["subscription"] != attached["PI_EVENTS_SUBSCRIPTION"]
                )
                result = subprocess.run(
                    [CLI, "status", second, "--json"],
                    env=attached,
                    capture_output=True,
                    text=True,
                    check=True,
                )
                assert json.loads(result.stdout)[0]["exit_code"] == 0
                old = subprocess.run(
                    [EVENTS_CLI, "publish", "--topic", "agent.result"],
                    env=attached,
                    input='{"text":"old attachment"}',
                    capture_output=True,
                    text=True,
                    check=False,
                )
                assert old.returncode == 3, old.stdout
                assert len(pi.notices()) == 1, pi.notices()
                fresh = {
                    **attached,
                    "PI_EVENTS_SUBSCRIPTION": pi.attachment["subscription"],
                }
                subprocess.run(
                    [CLI, "watch", second],
                    env=fresh,
                    capture_output=True,
                    text=True,
                    check=True,
                )
                pi.receive(lambda event: event.get("type") == "agent_end")
                notices = pi.notices()
                assert len(notices) == 2 and second in notices[1]["content"], notices
                assert "survived-pi-exit" in notices[1]["content"]
                for _ in range(2):
                    subprocess.run(
                        [
                            EVENTS_CLI,
                            "publish",
                            "--topic",
                            "agent.result",
                            "--id",
                            "c" * 32,
                        ],
                        env=fresh,
                        input='{"text":"generic result"}',
                        capture_output=True,
                        text=True,
                        check=True,
                    )
                pi.receive(lambda event: event.get("type") == "agent_end")
                time.sleep(0.5)
                assert (
                    len(
                        [
                            entry
                            for entry in pi.notices()
                            if entry["details"]["eventId"] == "c" * 32
                        ]
                    )
                    == 1
                )
                # Display-only progress never asks the model for a new turn.
                before = len(pi.notices())
                subprocess.run(
                    [EVENTS_CLI, "publish", "--topic", "agent.progress"],
                    env=fresh,
                    input='{"text":"working"}',
                    capture_output=True,
                    text=True,
                    check=True,
                )
                time.sleep(0.5)
                assert len(pi.notices()) == before
                attached = fresh
                # Registration must catch already-completed tasks; subsequent
                # native signals cannot duplicate a consumed watch.
                for command in ["echo instant\n", "echo failed; exit 7\n"]:
                    before = len(pi.notices())
                    handle = submit(command)
                    pi.receive(lambda event: event.get("type") == "agent_end")
                    time.sleep(0.3)
                    notices = pi.notices()
                    assert (
                        len(notices) == before + 1 and handle in notices[-1]["content"]
                    ), notices
                # Running kills use the native hook; queued removals need the
                # CLI signal because Pueue does not call its hook on removal.
                for queued in [False, True]:
                    if queued:
                        subprocess.run(
                            [
                                "pueue",
                                "--config",
                                env["PI_JOBS_CONFIG"],
                                "pause",
                                "--group",
                                "default",
                            ],
                            env=env,
                            check=True,
                            capture_output=True,
                        )
                    before = len(pi.notices())
                    handle = submit("sleep 30; echo should-not-complete\n")
                    subprocess.run(
                        [CLI, "stop", handle],
                        env=fresh,
                        check=True,
                        capture_output=True,
                    )
                    pi.receive(lambda event: event.get("type") == "agent_end")
                    assert (
                        len(pi.notices()) == before + 1
                        and handle in pi.notices()[-1]["content"]
                    )
                    if queued:
                        subprocess.run(
                            [
                                "pueue",
                                "--config",
                                env["PI_JOBS_CONFIG"],
                                "start",
                                "--group",
                                "default",
                            ],
                            env=env,
                            check=True,
                            capture_output=True,
                        )
                # A live completion after explicit unwatch must not wake Pi.
                before = len(pi.notices())
                handle = submit("sleep 0.5; echo unwatched\n")
                subprocess.run(
                    [CLI, "unwatch", handle], env=fresh, check=True, capture_output=True
                )
                time.sleep(1)
                assert len(pi.notices()) == before
                # Only an explicit check-in adds periodic status queries, and
                # its progress event must not trigger a model turn.
                handle = submit("sleep 12; echo checked-in\n", check_in=10)
                calls = len(trace.read_text().splitlines()) if trace else None
                time.sleep(10.5)
                assert len(pi.notices()) == before
                if trace:
                    assert len(trace.read_text().splitlines()) == calls + 1
                pi.receive(lambda event: event.get("type") == "agent_end")
                assert (
                    len(pi.notices()) == before + 1
                    and handle in pi.notices()[-1]["content"]
                )
                print(
                    json.dumps(
                        {
                            "pi": subprocess.check_output(
                                [PI, "--version"], text=True
                            ).strip(),
                            "responsive_before_completion": True,
                            "completion_triggered_turn": True,
                            "jobs_survive_sigkill": True,
                            "no_offline_replay": True,
                            "stale_attachment_rejected": True,
                            "explicit_rewatch": True,
                            "generic_event_deduplication": True,
                            "progress_does_not_wake": True,
                            "completion_polling": False,
                            "instant_and_failed_completions": True,
                            "running_and_queued_stop_notifications": True,
                            "unwatch_does_not_wake": True,
                            "explicit_check_in_queries_without_waking": True,
                        }
                    )
                )
            finally:
                if pi:
                    pi.close()
                daemon.terminate()
                daemon.wait(timeout=10)


if __name__ == "__main__":
    main()
