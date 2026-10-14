import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import events


class EventsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pe-", dir="/tmp")
        self.environment = patch.dict(os.environ, {"XDG_RUNTIME_DIR": self.temp.name})
        self.environment.start()
        self.subscribers = []

    def tearDown(self):
        for subscriber, thread in self.subscribers:
            subscriber.server.shutdown()
            subscriber.close()
            thread.join(2)
        self.environment.stop()
        self.temp.cleanup()

    def subscribe(self, topics, session):
        received = []
        subscriber = events.Subscriber(topics, session, received.append)
        thread = threading.Thread(
            target=subscriber.server.serve_forever,
            kwargs={"poll_interval": 0.01},
            daemon=True,
        )
        thread.start()
        self.subscribers.append((subscriber, thread))
        return subscriber, received

    def event(self, **changes):
        return {
            "version": 1,
            "id": "a" * 32,
            "topic": "job.completed",
            "source": "test",
            "payload": {"text": "done"},
            **changes,
        }

    def test_no_subscriber_means_no_spool(self):
        self.assertEqual(events.publish(self.event(), "closed")["accepted"], 0)
        self.assertEqual(list(events.runtime().iterdir()), [])
        _, received = self.subscribe(["job.*"], "closed")
        self.assertEqual(received, [])

    def test_fanout_and_targeting(self):
        _, first = self.subscribe(["job.*"], "one")
        _, second = self.subscribe(["job.completed"], "two")
        _, other = self.subscribe(["agent.*"], "one")
        self.assertEqual(events.publish(self.event(), "one")["accepted"], 1)
        self.assertEqual((len(first), len(second), len(other)), (1, 0, 0))
        self.assertEqual(events.publish(self.event(id="b" * 32))["accepted"], 2)

    def test_generation_binding_does_not_retarget_reopened_session(self):
        first, _ = self.subscribe(["job.*"], "same-session")
        old = first.record["id"]
        first.server.shutdown()
        first.close()
        _, received = self.subscribe(["job.*"], "same-session")
        self.assertEqual(
            events.publish(self.event(), "same-session", old)["accepted"], 0
        )
        self.assertEqual(received, [])

    def test_deduplication_and_conflicting_ids(self):
        _, received = self.subscribe(["job.*"], "one")
        for _ in range(2):
            self.assertEqual(events.publish(self.event(), "one")["accepted"], 1)
        self.assertEqual(len(received), 1)
        report = events.publish(self.event(payload={"text": "different"}), "one")
        self.assertEqual(report["accepted"], 0)
        self.assertIn("different content", report["errors"][0]["error"])

    def test_shared_socket_acknowledgments(self):
        fixtures = json.loads(
            Path(events.__file__).with_name("protocol.json").read_text()
        )
        subscriber, _ = self.subscribe(["agent.*"], "protocol")

        def send(frame):
            with socket.socket(socket.AF_UNIX) as conn:
                conn.settimeout(2)
                conn.connect(str(subscriber.socket))
                conn.sendall(
                    frame if isinstance(frame, bytes) else json.dumps(frame).encode()
                )
                conn.shutdown(socket.SHUT_WR)
                return events.read_frame(conn)["ok"]

        base = {
            "version": 1,
            "subscription": subscriber.record["id"],
            "token": subscriber.record["token"],
            "event": fixtures["event"],
        }
        for case in fixtures["frames"]:
            frame = {**base, **case.get("changes", {})}
            for key in case.get("remove", []):
                frame.pop(key, None)
            self.assertIs(send(frame), case["valid"])
        for index, case in enumerate(fixtures["duplicates"]):
            event = {**fixtures["event"], "id": f"{index:032x}"}
            self.assertTrue(
                send({**base, "event": {**event, "payload": case["first"]}})
            )
            self.assertIs(
                send({**base, "event": {**event, "payload": case["second"]}}),
                case["same"],
            )

        malformed = (
            json.dumps({**base, "event": {**fixtures["event"], "payload": "x"}})
            .encode()
            .replace(b'"x"', b'"\xff"')
        )
        self.assertFalse(send(malformed))

    def test_stale_socket_is_not_delivery(self):
        subscriber, _ = self.subscribe(["job.*"], "one")
        subscriber.server.shutdown()
        subscriber.server.server_close()
        report = events.publish(self.event(), "one")
        self.assertEqual(report["accepted"], 0)
        self.assertEqual(report["matched"], 1)

    def test_invalid_capability_is_rejected_before_dispatch(self):
        subscriber, received = self.subscribe(["job.*"], "one")
        with socket.socket(socket.AF_UNIX) as conn:
            conn.settimeout(2)
            conn.connect(str(subscriber.socket))
            conn.sendall(
                json.dumps(
                    {
                        "version": 1,
                        "subscription": subscriber.record["id"],
                        "token": "wrong",
                        "event": self.event(),
                    }
                ).encode()
            )
            conn.shutdown(socket.SHUT_WR)
            self.assertFalse(events.read_frame(conn)["ok"])
        self.assertEqual(received, [])

    def test_malformed_frames_are_rejected_without_crashing_subscriber(self):
        subscriber, received = self.subscribe(["job.*"], "one")
        for frame in [[], None, {"version": True}]:
            with socket.socket(socket.AF_UNIX) as conn:
                conn.settimeout(2)
                conn.connect(str(subscriber.socket))
                conn.sendall(json.dumps(frame).encode())
                conn.shutdown(socket.SHUT_WR)
                self.assertFalse(events.read_frame(conn)["ok"])
        self.assertEqual(received, [])
        self.assertEqual(events.publish(self.event(), "one")["accepted"], 1)

    def test_unicode_payload_limits_match_wire_encoding(self):
        _, received = self.subscribe(["job.*"], "one")
        self.assertEqual(
            events.publish(self.event(payload={"text": "界" * 4000}), "one")[
                "accepted"
            ],
            1,
        )
        self.assertEqual(len(received), 1)

    def test_text_cli_preserves_utf8_and_does_not_guess_json(self):
        _, received = self.subscribe(["agent.*"], "plain")
        command = [
            sys.executable,
            events.__file__,
            "publish",
            "--topic",
            "agent.result",
            "--to",
            "plain",
        ]
        for text in ["Build finished\n", '{"looks":"like JSON"}', "こんにちは 🌍\n"]:
            result = subprocess.run(
                [*command, "--text"],
                input=text.encode(),
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(received[-1]["payload"], {"text": text})
        result = subprocess.run(
            command, input=b'{"text":"structured"}', capture_output=True, check=False
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(received[-1]["payload"], {"text": "structured"})
        before = len(received)
        for flags, raw in [
            ([], b"not JSON"),
            (["--text"], b" \n"),
            (["--text"], b"\xff"),
            (["--text"], b"x" * (events.LIMIT + 1)),
            (["--text"], b"\x00" * 3000),
        ]:
            result = subprocess.run(
                [*command, *flags], input=raw, capture_output=True, check=False
            )
            self.assertEqual(result.returncode, 1)
        self.assertEqual(len(received), before)

    def test_private_files_and_symlink_rejection(self):
        subscriber, _ = self.subscribe(["job.*"], "one")
        self.assertEqual(subscriber.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(subscriber.socket.stat().st_mode & 0o777, 0o600)
        self.assertEqual(events.runtime().stat().st_mode & 0o777, 0o700)
        Path(self.temp.name, "other").mkdir()
        Path(self.temp.name, "other", "pi-events").symlink_to(events.runtime())
        with (
            patch.dict(
                os.environ, {"XDG_RUNTIME_DIR": str(Path(self.temp.name, "other"))}
            ),
            self.assertRaises(ValueError),
        ):
            events.runtime()


if __name__ == "__main__":
    unittest.main()
