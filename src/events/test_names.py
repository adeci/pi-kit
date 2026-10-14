import concurrent.futures
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import names

import events


class NamesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pn-", dir="/tmp")
        self.root = Path(self.temp.name)
        self.env = patch.dict(
            os.environ,
            {
                "XDG_STATE_HOME": str(self.root / "state"),
                "XDG_RUNTIME_DIR": str(self.root),
            },
        )
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def test_resume_reservation_rename_and_fork(self):
        first = names.claim("one")
        self.assertEqual(names.claim("one"), first)
        self.assertNotEqual(names.claim("two"), first)
        self.assertEqual(names.claim("one", "Albacore"), "albacore")
        before = (names.directory() / "names.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "reserved"):
            names.claim("two", "albacore")
        self.assertEqual((names.directory() / "names.json").read_bytes(), before)
        self.assertEqual(names.snapshot()["one"], "albacore")
        for value in ("a", "-bad", "bad--name", "hello world", "../no", "x" * 25, "🦦"):
            with self.assertRaises(ValueError):
                names.claim("one", value)

    def test_concurrent_processes_do_not_lose_claims(self):
        helper = Path(names.__file__)

        def run(owner, *extra):
            return subprocess.run(
                [sys.executable, str(helper), owner, *extra],
                capture_output=True,
                text=True,
                check=False,
            )

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(run, [f"session-{i}" for i in range(16)]))
        self.assertTrue(all(result.returncode == 0 for result in results))
        self.assertEqual(len({result.stdout for result in results}), 16)
        self.assertEqual(len(names.snapshot()), 16)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(
                pool.map(
                    lambda owner: run(owner, "chosen-name"), ["session-0", "session-1"]
                )
            )
        self.assertEqual(sorted(result.returncode for result in results), [0, 1])
        self.assertEqual(len(names.snapshot()), 16)

    def test_corruption_is_not_replaced(self):
        path = names.directory() / "names.json"
        for content in (
            '{"one":"miso","one":"otter"}',
            '{"one":"miso","two":"miso"}',
            "[]",
            "{broken",
            '{"one":"UPPER"}',
        ):
            path.write_text(content)
            with self.assertRaises((ValueError, TypeError)):
                names.claim("new")
            self.assertEqual(path.read_text(), content)

    def test_private_files_and_link_refusal(self):
        names.claim("one")
        directory = names.directory()
        self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual((directory / "names.json").stat().st_mode & 0o777, 0o600)
        for filename in ("names.json", "names.lock"):
            path = directory / filename
            saved = path.read_bytes()
            target = self.root / f"target-{filename}"
            target.write_bytes(saved)
            path.unlink()
            path.symlink_to(target)
            with self.assertRaises((OSError, ValueError)):
                names.claim("new")
            self.assertEqual(target.read_bytes(), saved)
            path.unlink()
            path.write_bytes(saved)

    def test_offline_unknown_and_ambiguous_targets(self):
        names.claim("one", "miso")
        with self.assertRaisesRegex(ValueError, "Unknown"):
            events.named_target("unknown")
        with self.assertRaisesRegex(ValueError, "offline"):
            events.named_target("miso")
        first = events.Subscriber(["session.message"], "one", lambda _: None)
        second = None
        try:
            self.assertEqual(events.named_target("Miso")["id"], first.record["id"])
            second = events.Subscriber(["session.message"], "one", lambda _: None)
            with self.assertRaisesRegex(ValueError, "ambiguous"):
                events.named_target("miso")
        finally:
            first.close()
            if second:
                second.close()
        self.assertEqual(names.snapshot()["one"], "miso")

    def test_send_delivers_text_and_list_includes_offline_reservations(self):
        names.claim("one", "miso")
        names.claim("two", "otter")
        received = []
        subscriber = events.Subscriber(["session.message"], "one", received.append)
        worker = threading.Thread(
            target=lambda: subscriber.server.serve_forever(poll_interval=0.01)
        )
        worker.start()
        try:
            result = subprocess.run(
                [sys.executable, str(Path(events.__file__)), "send", "miso"],
                input="hello 界\n",
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["accepted"], 1)
            self.assertEqual(received[0]["payload"], {"text": "hello 界\n"})
            with (
                patch.object(sys, "argv", ["pi-events", "list", "--all"]),
                contextlib.redirect_stdout(io.StringIO()) as out,
            ):
                self.assertEqual(events.main(), 0)
            rows = json.loads(out.getvalue())
            self.assertEqual({row["name"] for row in rows}, {"miso", "otter"})
            self.assertIsNone(next(row for row in rows if row["name"] == "otter")["id"])
            self.assertTrue(all("token" not in row for row in rows))
        finally:
            subscriber.server.shutdown()
            worker.join()
            subscriber.close()

    def test_send_binds_before_reading_and_rejects_oversized_text(self):
        names.claim("one", "miso")
        first = events.Subscriber(["session.message"], "one", lambda _: None)
        old = first.record
        replacement = None

        def read(_size):
            nonlocal replacement
            first.close()
            replacement = events.Subscriber(
                ["session.message"], "one", lambda _: self.fail("Retargeted")
            )
            return b"build finished\n"

        try:
            with (
                patch.object(sys, "argv", ["pi-events", "send", "miso"]),
                patch.object(
                    sys,
                    "stdin",
                    types.SimpleNamespace(buffer=types.SimpleNamespace(read=read)),
                ),
                contextlib.redirect_stdout(io.StringIO()) as out,
            ):
                self.assertEqual(events.main(), 3)
            self.assertEqual(json.loads(out.getvalue())["matched"], 0)
            self.assertNotEqual(replacement.record["id"], old["id"])
            for raw in (b"", b" " * 10, b"x" * 8193, b"x" * 16385, b"\xff"):
                with (
                    patch.object(sys, "argv", ["pi-events", "send", "miso"]),
                    patch.object(
                        sys, "stdin", types.SimpleNamespace(buffer=io.BytesIO(raw))
                    ),
                    contextlib.redirect_stderr(io.StringIO()),
                ):
                    self.assertEqual(events.main(), 1)
        finally:
            if replacement:
                replacement.close()
            else:
                first.close()


if __name__ == "__main__":
    unittest.main()
