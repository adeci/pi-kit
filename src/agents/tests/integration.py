#!/usr/bin/env python3
"""Real stock-Pi orchestration with an offline scripted provider; no credentials."""

import json
import os
import queue
import shutil
import subprocess
import tempfile
import threading
import time
from contextlib import ExitStack
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PI = os.environ.get("PI_BINARY", shutil.which("pi"))
EXTENSION = os.environ.get("PI_AGENTS_TEST_EXTENSION", str(ROOT / "extension/index.ts"))
FIXTURE = ROOT / "tests/fixture.ts"
TERMINAL = {
    "completed",
    "blocked",
    "failed",
    "cancelled",
    "interrupted",
    "budget",
    "timeout",
}


def until(predicate, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.03)
    raise AssertionError("Fixture condition timed out")


def running(pid):
    try:
        os.kill(pid, 0)
        path = Path(f"/proc/{pid}/stat")
        return not path.exists() or path.read_text().split()[2] != "Z"
    except ProcessLookupError:
        return False


class Pi:
    def __init__(self, env, cwd, directory, session=None, extensions=()):
        self.resources = ExitStack()
        self.log = self.resources.enter_context(
            (directory / f"pi-{time.time_ns()}.log").open("w+")
        )
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
            str(FIXTURE),
            "-e",
            EXTENSION,
            "--model",
            "pi-agents-fixture/scripted",
            "--session-dir",
            str(directory / "sessions"),
        ]
        for extension in extensions:
            args.extend(["-e", str(extension)])
        suite = os.environ.get("PI_KIT_TEST_SUITE")
        if suite:
            for name in ("events", "jobs"):
                args.extend(["-e", str(Path(suite) / "share/pi-kit" / name)])
            for name in ("kit-agents", "kit-jobs"):
                args.extend(["--skill", str(Path(suite) / "share/skills" / name)])
        if os.environ.get("PI_AGENTS_TEST_AUTO"):
            args.remove("--no-extensions")
            extensions = Path(env["PI_CODING_AGENT_DIR"]) / "extensions"
            extensions.mkdir(parents=True, exist_ok=True)
            source = Path(EXTENSION)
            source = (
                source.parent
                if source.is_file()
                else source / "extension"
                if (source / "extension").is_dir()
                else source
            )
            link = extensions / "kit-agents"
            if not link.exists():
                link.symlink_to(source, target_is_directory=True)
            if suite:
                for name in ("events", "jobs"):
                    link = extensions / name
                    if not link.exists():
                        link.symlink_to(
                            Path(suite) / "share/pi-kit" / name / "extension",
                            target_is_directory=True,
                        )
        if session:
            args.extend(["--session", session])
        self.process = subprocess.Popen(
            args,
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self.log,
            text=True,
        )
        self.events = queue.Queue()
        self.seen = []
        self.sequence = 0
        threading.Thread(target=self.read, daemon=True).start()
        self.state = self.call("get_state")
        self.tree = (
            Path(env["PI_AGENTS_STATE_DIR"]) / self.state["sessionId"] / "agents.json"
        )
        until(lambda: self.tree.exists())

    def read(self):
        for line in self.process.stdout:
            try:
                self.events.put(json.loads(line))
            except json.JSONDecodeError:
                pass

    def receive(self, predicate, seconds=30):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                event = self.events.get(timeout=0.1)
            except queue.Empty:
                if self.process.poll() is not None:
                    break
                continue
            self.seen.append(event)
            if predicate(event):
                return event
        self.log.flush()
        self.log.seek(0)
        raise AssertionError(
            f"Expected RPC event absent; stderr={self.log.read()}; recent={self.seen[-15:]}"
        )

    def call(self, command, **fields):
        self.sequence += 1
        id_ = f"test-{self.sequence}"
        self.process.stdin.write(
            json.dumps({"id": id_, "type": command, **fields}) + "\n"
        )
        self.process.stdin.flush()
        response = self.receive(
            lambda event: event.get("type") == "response" and event.get("id") == id_
        )
        assert response["success"], response
        return response.get("data")

    def control(self, operation, **args):
        self.call(
            "prompt",
            message="CONTROL "
            + json.dumps({"operation": operation, "args": args})
            + "\nPARENT_PRIVATE_SENTINEL",
            streamingBehavior="followUp",
        )
        event = self.receive(
            lambda item: (
                item.get("type") == "tool_execution_end"
                and item.get("toolName") == f"agent_{operation}"
            )
        )
        assert not event.get("isError"), event
        return event["result"]["details"]

    def saved(self):
        return json.loads(self.tree.read_text())["agents"]

    def agent(self, id_):
        return next((a for a in self.saved() if a["id"] == id_), None)

    def finished(self, id_):
        return until(
            lambda: (
                (agent := self.agent(id_))
                and agent["assignments"][-1]["state"] in TERMINAL
                and agent
            )
        )

    def close(self, crash=False):
        if self.process.poll() is None:
            if crash:
                self.process.kill()
            else:
                self.process.stdin.close()
            self.process.wait(timeout=20)
        self.resources.close()


def main():
    assert PI, "Install stock Pi or set PI_BINARY"
    with tempfile.TemporaryDirectory(prefix="pa-", dir="/tmp") as temporary:
        directory = Path(temporary)
        repo = directory / "repo"
        repo.mkdir()

        def git(*args):
            return subprocess.check_output(
                ["git", "-C", str(repo), *args], stderr=subprocess.DEVNULL, text=True
            )

        git("init")
        git("config", "user.name", "Fixture")
        git("config", "user.email", "fixture@localhost")
        (repo / "tracked.txt").write_text("base\n")
        (repo / ".gitignore").write_text("*.secret\n")
        git("add", ".")
        git("commit", "-m", "base")
        (repo / "tracked.txt").write_text("staged\n")
        git("add", "tracked.txt")
        (repo / "tracked.txt").write_text("working\n")
        (repo / "draft.txt").write_text("untracked baseline\n")
        (repo / "token.secret").write_text("ignored fixture\n")
        index = git("ls-files", "--stage")
        skill = directory / "fixture-skill"
        skill.mkdir()
        (skill / "SKILL.md").write_text(
            "---\nname: fixture-skill\ndescription: FIXTURE_SELECTED_SKILL\n---\nOffline fixture skill.\n"
        )
        config = directory / "agents-config.json"
        config.write_text(
            json.dumps(
                {
                    "version": 1,
                    "maxConcurrency": 1,
                    "idleTtlMs": 150,
                    "roles": {
                        name: {
                            "model": "pi-agents-fixture/scripted",
                            "extensions": [str(FIXTURE)],
                            **({"skills": [str(skill)]} if name == "scout" else {}),
                            **(
                                {
                                    "writable": False,
                                    "tools": ["read"],
                                    "requestBudget": 2,
                                }
                                if name == "sonic"
                                else {}
                            ),
                        }
                        for name in ["task", "scout", "reviewer", "sonic"]
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
                "PI_AGENTS_TEST_TRACE": str(directory / "trace.jsonl"),
                "PI_OFFLINE": "1",
                "PI_TELEMETRY": "0",
            }
        )
        if suite := os.environ.get("PI_KIT_TEST_SUITE"):
            env["PATH"] = str(Path(suite) / "bin") + os.pathsep + env["PATH"]
            env["PI_EVENTS_BIN"] = str(Path(suite) / "bin/pi-events")
        Path(env["HOME"]).mkdir()
        Path(env["XDG_RUNTIME_DIR"]).mkdir(mode=0o700)
        pi = Pi(env, repo, directory)
        try:
            writer = pi.control("spawn", task="SCENARIO write", role="task")
            result = pi.finished(writer["id"])
            assert result["assignments"][-1]["state"] == "completed", result
            assert (repo / "tracked.txt").read_text() == "working\n"
            assert (
                Path(result["cwd"]) / "draft.txt"
            ).read_text() == "untracked baseline\n"
            assert not (Path(result["cwd"]) / "token.secret").exists()
            patch = Path(result["assignments"][-1]["patch"]).read_text()
            assert "draft.txt" not in patch and "-working" in patch
            assert pi.control("integrate", id=writer["id"])["applied"]
            assert (repo / "tracked.txt").read_text() == "agent change\n"
            assert git("ls-files", "--stage") == index
            session = pi.call("get_state")["sessionFile"]
            until(
                lambda: any(
                    json.loads(line).get("customType") == "pi-agents-result"
                    for line in Path(session).read_text().splitlines()
                )
            )

            reusable = pi.control(
                "spawn",
                task="SCENARIO simple FIRST_OWN_CONTEXT",
                role="scout",
                lifetime="reusable",
            )
            pi.finished(reusable["id"])
            until(lambda: pi.agent(reusable["id"])["state"] == "parked")
            pi.control(
                "assign",
                id=reusable["id"],
                task="SCENARIO simple SECOND_OWN_CONTEXT",
                model="pi-agents-fixture/scripted-alt",
                thinking="off",
            )
            reused = pi.finished(reusable["id"])
            assert reused["model"] == "pi-agents-fixture/scripted-alt"
            assert len(reused["assignments"]) == 2
            assert reused["assignments"][-1]["state"] == "completed"
            traces = [
                json.loads(line)
                for line in Path(env["PI_AGENTS_TEST_TRACE"]).read_text().splitlines()
            ]
            own = [
                trace
                for trace in traces
                if trace["assignment"] == f"{reusable['id']}:2"
            ]
            assert own and "FIRST_OWN_CONTEXT" in json.dumps(own)
            assert "FIXTURE_SELECTED_SKILL" in json.dumps(own)
            assert "PARENT_PRIVATE_SENTINEL" not in json.dumps(traces)
            pi.control(
                "send", id=reusable["id"], message="SCENARIO simple THIRD_OWN_CONTEXT"
            )
            sent = pi.finished(reusable["id"])
            assert (
                len(sent["assignments"]) == 3
                and sent["assignments"][-1]["state"] == "completed"
            ), sent

            parent = pi.control("spawn", task="SCENARIO nested", role="reviewer")
            until(
                lambda: any(
                    a["parent"] == parent["id"] and a["state"] == "running"
                    for a in pi.saved()
                )
            )
            queued = pi.control("spawn", task="SCENARIO delay", role="reviewer")
            assert pi.agent(queued["id"])["state"] == "queued", pi.saved()
            nested = pi.finished(parent["id"])
            assert nested["assignments"][-1]["state"] == "completed", nested
            assert any(a["depth"] == 2 for a in pi.saved())
            pi.finished(queued["id"])
            depth = pi.control(
                "spawn", task="SCENARIO nested depth-test", role="reviewer"
            )
            pi.finished(depth["id"])
            assert max(a["depth"] for a in pi.saved()) == 2
            assert any(
                a["parent"] == depth["id"]
                and a["assignments"][-1]["state"] == "blocked"
                for a in pi.saved()
            )

            budget = pi.control("spawn", task="SCENARIO loop", role="sonic")
            limited = pi.finished(budget["id"])
            assert limited["assignments"][-1]["state"] == "budget", limited
            assert limited["assignments"][-1]["report"], limited
            pi.control("resume", id=budget["id"], task="SCENARIO simple")
            assert pi.finished(budget["id"])["assignments"][-1]["state"] == "completed"

            hang = pi.control(
                "spawn", task="SCENARIO hang", role="task", isolated=False
            )
            until(lambda: (repo / "shell.pid").exists())
            shell = int((repo / "shell.pid").read_text())
            waited = pi.control("wait", ids=[hang["id"]], timeoutSeconds=1)
            assert waited["outcome"] == "elapsed" and running(shell)
            pi.control("stop", id=hang["id"])
            until(lambda: not running(shell))
            assert pi.agent(hang["id"])["assignments"][-1]["state"] == "cancelled"

            crash = pi.control(
                "spawn", task="SCENARIO hang", role="task", isolated=False
            )
            until(
                lambda: (
                    (repo / "shell.pid").exists()
                    and int((repo / "shell.pid").read_text()) != shell
                )
            )
            shell = int((repo / "shell.pid").read_text())
            worker = int(
                (Path(pi.agent(crash["id"])["directory"]) / "worker.pid").read_text()
            )
            session = pi.call("get_state")["sessionFile"]
            pi.close(crash=True)
            until(lambda: not running(worker) and not running(shell), 10)
            before = Path(env["PI_AGENTS_TEST_TRACE"]).read_text()
            pi = Pi(env, repo, directory, session)
            assert pi.agent(crash["id"])["state"] == "parked"
            assert pi.agent(crash["id"])["assignments"][-1]["state"] == "interrupted"
            time.sleep(0.4)
            assert Path(env["PI_AGENTS_TEST_TRACE"]).read_text() == before
            pi.control("resume", id=crash["id"], task="SCENARIO simple")
            assert pi.finished(crash["id"])["assignments"][-1]["state"] == "completed"
            print(
                json.dumps(
                    {
                        "pi": subprocess.check_output(
                            [PI, "--version"], text=True
                        ).strip(),
                        "isolation": True,
                        "integration": True,
                        "automatic_result": True,
                        "reusable_context": True,
                        "no_parent_history": True,
                        "per_session_concurrency": True,
                        "nested_depth": True,
                        "budget_partial": True,
                        "wait_does_not_stop": True,
                        "branch_stop": True,
                        "crash_cleanup": True,
                        "no_auto_resume": True,
                        "explicit_resume": True,
                    }
                )
            )
        finally:
            pi.close()


if __name__ == "__main__":
    main()
