#!/usr/bin/env python3
"""Live, same-user Unix-socket events. No spool, daemon, or request replay."""

import argparse
import hashlib
import json
import math
import os
import re
import secrets
import signal
import socket
import socketserver
import stat
import sys
import threading
import time
from pathlib import Path

import names

LIMIT = 16384
EVENT_BYTES = 15360
TOPICS = 64
DUPLICATES = 256
TOPIC = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}\Z")
IDENT = re.compile(r"[a-f0-9]{32}\Z")


def runtime():
    root = os.environ.get("XDG_RUNTIME_DIR")
    if not root:
        raise ValueError("XDG_RUNTIME_DIR is required")
    path = Path(root) / "pi-events"
    path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError("Event directory must be owned by this user and not a symlink")
    path.chmod(0o700)
    return path


def matches(pattern, topic):
    return pattern == topic or (
        pattern.endswith(".*") and topic.startswith(pattern[:-1])
    )


def pattern(value):
    if not isinstance(value, str) or not TOPIC.fullmatch(value.removesuffix(".*")):
        raise ValueError("Invalid topic")
    return value


def check_numbers(value):
    if isinstance(value, dict):
        for item in value.values():
            check_numbers(item)
    elif isinstance(value, list):
        for item in value:
            check_numbers(item)
    elif type(value) is int:
        if abs(value) > 9007199254740991:
            raise ValueError("Large event integers must be strings")
    elif type(value) is float and (
        not math.isfinite(value)
        or (value.is_integer() and abs(value) > 9007199254740991)
    ):
        raise ValueError("Event numbers must be finite; large integers must be strings")


def validate(event):
    if (
        not isinstance(event, dict)
        or isinstance(event.get("version"), bool)
        or event.get("version") != 1
    ):
        raise ValueError("Invalid event version")
    if not isinstance(event.get("id"), str) or not IDENT.fullmatch(event["id"]):
        raise ValueError("Event ID must be 32 lowercase hex characters")
    if not isinstance(event.get("topic"), str) or not TOPIC.fullmatch(event["topic"]):
        raise ValueError("Invalid event topic")
    if not isinstance(event.get("source"), str) or not TOPIC.fullmatch(event["source"]):
        raise ValueError("Invalid event source")
    if "payload" not in event:
        raise ValueError("An event needs a payload")
    check_numbers(event)
    if (
        len(
            json.dumps(
                event, ensure_ascii=False, allow_nan=False, separators=(",", ":")
            ).encode()
        )
        > EVENT_BYTES
    ):
        raise ValueError("Event exceeds size limit")
    return event


def validate_frame(frame, subscription, token):
    if (
        not isinstance(frame, dict)
        or isinstance(frame.get("version"), bool)
        or frame.get("version") != 1
        or frame.get("subscription") != subscription
        or not isinstance(frame.get("token"), str)
        or not frame["token"].isascii()
        or not secrets.compare_digest(frame["token"], token)
    ):
        raise ValueError("Invalid subscription capability")
    return validate(frame["event"])


def fingerprint(event):
    def normalize(value):
        if isinstance(value, dict):
            return {key: normalize(item) for key, item in value.items()}
        if isinstance(value, list):
            return [normalize(item) for item in value]
        if isinstance(value, float) and value.is_integer():
            return int(value)
        return value

    return hashlib.sha256(
        json.dumps(
            normalize(event), sort_keys=True, ensure_ascii=False, allow_nan=False
        ).encode()
    ).hexdigest()


def read_frame(conn, deadline=None):
    chunks = bytearray()
    while True:
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Publication deadline exceeded")
            conn.settimeout(min(2, remaining))
        part = conn.recv(4096)
        if not part:
            break
        chunks.extend(part)
        if len(chunks) > LIMIT:
            raise ValueError("Frame exceeds size limit")
    return json.loads(chunks.decode("utf-8"))


def records():
    directory = runtime()
    for path in sorted(directory.glob("*.json")):
        try:
            info = path.lstat()
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.getuid()
                or info.st_size > LIMIT
            ):
                continue
            record = json.loads(path.read_text())
            ident = record["id"]
            if (
                not IDENT.fullmatch(ident)
                or path.name != f"{ident}.json"
                or record.get("version") != 1
            ):
                continue
            if (
                not isinstance(record["session"], str)
                or not 0 < len(record["session"]) <= 256
            ):
                continue
            if not IDENT.fullmatch(record["token"]):
                continue
            if (
                not isinstance(record["topics"], list)
                or not 0 < len(record["topics"]) <= TOPICS
            ):
                continue
            for topic in record["topics"]:
                pattern(topic)
            yield record, directory / f"{ident}.sock"
        except (OSError, ValueError, KeyError, TypeError):
            continue


def publish(event, session=None, subscription=None):
    validate(event)
    accepted = matched = 0
    errors = []
    omitted = 0
    limited = False
    deadline = time.monotonic() + 4

    def error(record, message):
        nonlocal omitted
        if len(errors) < 8:
            errors.append({"subscription": record["id"], "error": str(message)[:256]})
        else:
            omitted += 1

    for record, path in records():
        if session is not None and record["session"] != session:
            continue
        if subscription is not None and record["id"] != subscription:
            continue
        if not any(matches(p, event["topic"]) for p in record["topics"]):
            continue
        if matched >= 64 or time.monotonic() >= deadline:
            limited = True
            break
        matched += 1
        frame = {
            "version": 1,
            "subscription": record["id"],
            "token": record["token"],
            "event": event,
        }
        try:
            with socket.socket(socket.AF_UNIX) as conn:
                conn.settimeout(min(2, max(0.001, deadline - time.monotonic())))
                conn.connect(str(path))
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Publication deadline exceeded")
                conn.settimeout(min(2, remaining))
                conn.sendall(
                    json.dumps(
                        frame,
                        ensure_ascii=False,
                        allow_nan=False,
                        separators=(",", ":"),
                    ).encode()
                )
                conn.shutdown(socket.SHUT_WR)
                reply = read_frame(conn, deadline)
                if not isinstance(reply, dict):
                    raise TypeError("Invalid subscriber acknowledgment")
                if reply.get("ok") is True:
                    accepted += 1
                else:
                    error(record, reply.get("error", "Rejected"))
        except (OSError, ValueError, TypeError) as failure:
            error(record, failure)
    return {
        "matched": matched,
        "accepted": accepted,
        "errors": errors,
        "errors_omitted": omitted,
        "limited": limited,
    }


class Subscriber:
    def __init__(self, topics, session, callback):
        self.directory = runtime()
        self.record = {
            "version": 1,
            "id": secrets.token_hex(16),
            "token": secrets.token_hex(16),
            "session": session,
            "topics": [pattern(t) for t in topics],
        }
        if (
            not self.record["topics"]
            or len(self.record["topics"]) > TOPICS
            or not 0 < len(session) <= 256
        ):
            raise ValueError("Invalid subscription")
        self.path = self.directory / f"{self.record['id']}.json"
        self.socket = self.directory / f"{self.record['id']}.sock"
        if len(os.fsencode(self.socket)) > 100:
            raise ValueError("Socket path too long; use a shorter XDG_RUNTIME_DIR")
        self.callback = callback
        self.seen = {}
        self.lock = threading.Lock()
        owner = self

        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                self.request.settimeout(2)
                try:
                    frame = read_frame(self.request)
                    event = validate_frame(
                        frame, owner.record["id"], owner.record["token"]
                    )
                    if not any(
                        matches(t, event["topic"]) for t in owner.record["topics"]
                    ):
                        raise ValueError("Topic is not subscribed")
                    digest = fingerprint(event)
                    with owner.lock:
                        previous = owner.seen.get(event["id"])
                        if previous and previous != digest:
                            raise ValueError("Event ID reused with different content")
                        if not previous:
                            owner.callback(event)
                            owner.seen[event["id"]] = digest
                            if len(owner.seen) > DUPLICATES:
                                del owner.seen[next(iter(owner.seen))]
                    reply = {"ok": True}
                except (OSError, ValueError, KeyError, TypeError) as error:
                    reply = {"ok": False, "error": str(error)[:256]}
                try:
                    self.request.sendall(json.dumps(reply).encode())
                except OSError:
                    pass

        self.server = socketserver.UnixStreamServer(str(self.socket), Handler)
        self.socket.chmod(0o600)
        try:
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as file:
                json.dump(self.record, file)
        except BaseException:
            self.server.server_close()
            self.socket.unlink(missing_ok=True)
            raise

    def close(self):
        self.path.unlink(missing_ok=True)
        self.server.server_close()
        self.socket.unlink(missing_ok=True)


def named_target(name):
    name = names.normalize(name)
    owner = next(
        (owner for owner, value in names.snapshot().items() if value == name), None
    )
    if owner is None:
        raise ValueError(f"Unknown session name: {name}")
    candidates = [
        r
        for r, _ in records()
        if r["session"] == owner
        and any(matches(p, "session.message") for p in r["topics"])
    ]
    if not candidates:
        raise ValueError(
            f"Session '{name}' is offline or not subscribed to session.message; nothing queued"
        )
    if len(candidates) != 1:
        raise ValueError(
            f"Session '{name}' has multiple subscription records; refusing an ambiguous target"
        )
    return candidates[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", action="version", version="pi-events 0.2.0")
    commands = parser.add_subparsers(dest="command", required=True)
    pub = commands.add_parser(
        "publish", help="Read JSON payload from stdin; send only to live subscribers"
    )
    pub.add_argument("--topic", required=True)
    pub.add_argument(
        "--text",
        action="store_true",
        help="Wrap UTF-8 stdin as a text payload instead of parsing JSON",
    )
    pub.add_argument("--source", default="cli")
    pub.add_argument("--to", default=os.environ.get("PI_EVENTS_SESSION"))
    pub.add_argument(
        "--broadcast",
        action="store_true",
        help="Ignore the current session and fan out",
    )
    pub.add_argument(
        "--subscription", help="Bind delivery to one attachment generation"
    )
    pub.add_argument("--id", default=None)
    send = commands.add_parser(
        "send", help="Read plaintext stdin and send to one named live Pi session"
    )
    send.add_argument("name")
    sub = commands.add_parser("subscribe", help="Print matching events until stopped")
    sub.add_argument("--topic", action="append", required=True)
    sub.add_argument("--session", required=True)
    listing = commands.add_parser(
        "list",
        help="Show named subscription records; advertisements are not a liveness guarantee",
    )
    listing.add_argument(
        "--all", action="store_true", help="Include reserved names without a subscriber"
    )
    args = parser.parse_args()
    try:
        if args.command == "send":
            # Bind before waiting for stdin: a long pipeline cannot follow a new
            # attachment or a reused name when it eventually finishes.
            target = named_target(args.name)
            raw = sys.stdin.buffer.read(LIMIT + 1)
            if len(raw) > LIMIT:
                raise ValueError(
                    "Text exceeds size limit; send a log path and excerpt instead"
                )
            text = raw.decode("utf-8")
            if not text.strip():
                raise ValueError("Text payload must be nonempty")
            if len(text.encode("utf-16-le")) // 2 > 8192:
                raise ValueError(
                    "Text exceeds Pi's 8192-unit display limit; send a log path and excerpt instead"
                )
            report = publish(
                {
                    "version": 1,
                    "id": secrets.token_hex(16),
                    "topic": "session.message",
                    "source": "cli",
                    "payload": {"text": text},
                },
                target["session"],
                target["id"],
            )
            print(json.dumps({"name": names.normalize(args.name), **report}))
            return 0 if report["accepted"] else 3
        if args.command == "publish":
            raw = sys.stdin.buffer.read(LIMIT + 1)
            if len(raw) > LIMIT:
                raise ValueError("Payload exceeds size limit")
            text = raw.decode("utf-8") if args.text else None
            if args.text and not text.strip():
                raise ValueError("Text payload must be nonempty")
            event = {
                "version": 1,
                "id": args.id or secrets.token_hex(16),
                "topic": args.topic,
                "source": args.source,
                "payload": {"text": text}
                if args.text
                else json.loads(raw.decode("utf-8")),
            }
            if not args.broadcast and not args.to:
                raise ValueError("Specify --to SESSION or --broadcast outside Pi")
            subscription = args.subscription
            if subscription is None and args.to == os.environ.get("PI_EVENTS_SESSION"):
                subscription = os.environ.get("PI_EVENTS_SUBSCRIPTION")
            report = publish(
                event,
                None if args.broadcast else args.to,
                None if args.broadcast else subscription,
            )
            print(json.dumps(report))
            return 0 if report["accepted"] else 3
        if args.command == "list":
            reserved = names.snapshot()
            rows = [
                {
                    "name": reserved.get(r["session"]),
                    **{k: r[k] for k in ("id", "session", "topics")},
                }
                for r, _ in records()
            ]
            if args.all:
                advertised = {r["session"] for r in rows}
                rows.extend(
                    {"name": name, "session": owner, "id": None, "topics": []}
                    for owner, name in reserved.items()
                    if owner not in advertised
                )
            print(json.dumps(rows))
            return 0
        subscriber = Subscriber(
            args.topic, args.session, lambda e: print(json.dumps(e), flush=True)
        )

        def stop(_signal, _frame):
            raise KeyboardInterrupt

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        try:
            subscriber.server.serve_forever(poll_interval=0.1)
        except KeyboardInterrupt:
            pass
        finally:
            subscriber.close()
        return 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"pi-events: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
