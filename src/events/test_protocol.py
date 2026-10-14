import json
import unittest
from pathlib import Path

import events

FIXTURES = json.loads(Path(__file__).with_name("protocol.json").read_text())


def candidate(case):
    event = {**FIXTURES["event"], **case.get("changes", {})}
    for key in case.get("remove", []):
        event.pop(key, None)
    if "rawPayload" in case:
        event["payload"] = json.loads(case["rawPayload"])
    return event


class ProtocolTests(unittest.TestCase):
    def check(self, operation, valid):
        if valid:
            operation()
        else:
            with self.assertRaises((ValueError, KeyError, TypeError)):
                operation()

    def test_limits(self):
        self.assertEqual(
            FIXTURES["limits"],
            {
                "frameBytes": events.LIMIT,
                "eventBytes": events.EVENT_BYTES,
                "topics": events.TOPICS,
                "duplicates": events.DUPLICATES,
            },
        )

    def test_events(self):
        for case in FIXTURES["events"]:
            with self.subTest(case=case["name"]):
                self.check(
                    lambda case=case: events.validate(candidate(case)), case["valid"]
                )

    def test_encoded_size(self):
        for case in FIXTURES["sizes"]:
            with self.subTest(case=case):
                event = {
                    **FIXTURES["event"],
                    "payload": case["character"] * case["count"],
                }
                self.check(lambda event=event: events.validate(event), case["valid"])

    def test_topics(self):
        for case in FIXTURES["patterns"]:
            self.assertEqual(
                events.matches(case["pattern"], case["topic"]), case["matches"]
            )

    def test_frames(self):
        for case in FIXTURES["frames"]:
            with self.subTest(case=case["name"]):
                frame = {
                    "version": 1,
                    "subscription": "a" * 32,
                    "token": "a" * 32,
                    "event": FIXTURES["event"],
                    **case.get("changes", {}),
                }
                for key in case.get("remove", []):
                    frame.pop(key, None)
                self.check(
                    lambda frame=frame: events.validate_frame(
                        frame, "a" * 32, "a" * 32
                    ),
                    case["valid"],
                )

    def test_duplicate_identity(self):
        for case in FIXTURES["duplicates"]:
            first = {**FIXTURES["event"], "payload": case["first"]}
            second = {**FIXTURES["event"], "payload": case["second"]}
            self.assertEqual(
                events.fingerprint(first) == events.fingerprint(second), case["same"]
            )


if __name__ == "__main__":
    unittest.main()
