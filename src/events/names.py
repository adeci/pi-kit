#!/usr/bin/env python3
"""Persistent friendly addresses. Also used privately by the Pi adapter."""

import contextlib
import fcntl
import json
import os
import re
import secrets
import stat
import sys
import tempfile
import time
from pathlib import Path

WORDS = [
    "albacore",
    "apricot",
    "aster",
    "badger",
    "bean",
    "birch",
    "blossom",
    "boba",
    "bunny",
    "buttercup",
    "cherry",
    "chickadee",
    "clover",
    "cocoa",
    "comet",
    "coral",
    "cricket",
    "daisy",
    "dandelion",
    "dove",
    "fern",
    "finch",
    "hazel",
    "heron",
    "juniper",
    "kiwi",
    "koala",
    "lark",
    "lilac",
    "lotus",
    "maple",
    "marigold",
    "meadow",
    "mimosa",
    "miso",
    "mochi",
    "moss",
    "mouse",
    "nectarine",
    "olive",
    "otter",
    "peach",
    "pebble",
    "petal",
    "pickle",
    "pine",
    "pip",
    "pippin",
    "plover",
    "plum",
    "poppy",
    "puffin",
    "quail",
    "robin",
    "sesame",
    "sorrel",
    "sparrow",
    "sprout",
    "starling",
    "sunflower",
    "sweetpea",
    "thistle",
    "thyme",
    "tulip",
    "turtle",
    "violet",
    "willow",
    "wren",
    "yarrow",
]
PREFIXES = [
    "amber",
    "blue",
    "cozy",
    "dewy",
    "little",
    "mellow",
    "mint",
    "moon",
    "rosy",
    "soft",
    "sunny",
    "tiny",
]
MAX_BYTES = 8 * 1024 * 1024


def normalize(value):
    value = value.lower()
    if not 2 <= len(value) <= 24 or not re.fullmatch(
        r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", value
    ):
        raise ValueError(
            "Names need 2–24 letters, digits or single hyphens; start with a letter"
        )
    return value


def directory():
    root = Path(os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local/state"))
    if not root.is_absolute():
        raise ValueError("XDG_STATE_HOME must be absolute")
    root.mkdir(parents=True, exist_ok=True)
    for part in ("pi-kit", "events"):
        root /= part
        root.mkdir(mode=0o700, exist_ok=True)
        info = root.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError(
                "Names directory must be owned by this user and not a symlink"
            )
        root.chmod(0o700)
    return root


def private_open(path, flags):
    fd = os.open(path, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    info = os.fstat(fd)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_nlink != 1
    ):
        os.close(fd)
        raise ValueError("Names files must be private regular files, not links")
    os.fchmod(fd, 0o600)
    return fd


@contextlib.contextmanager
def locked():
    root = directory()
    fd = private_open(root / "names.lock", os.O_RDWR | os.O_CREAT)
    try:
        deadline = time.monotonic() + 1
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise ValueError(
                        "Names registry is busy; retry the operation"
                    ) from None
                time.sleep(0.01)
        path = root / "names.json"
        try:
            with os.fdopen(private_open(path, os.O_RDONLY), "r") as file:
                text = file.read(MAX_BYTES + 1)
            if len(text.encode()) > MAX_BYTES:
                raise ValueError("Names registry exceeds size limit")

            # Duplicate JSON keys must not silently discard a reservation.
            def pairs(items):
                result = {}
                for key, value in items:
                    if key in result:
                        raise ValueError("Duplicate session in names registry")
                    result[key] = value
                return result

            data = json.loads(text, object_pairs_hook=pairs)
            if not isinstance(data, dict):
                raise TypeError("Invalid names registry")
            for owner, name in data.items():
                if not isinstance(owner, str) or not 0 < len(owner) <= 256:
                    raise ValueError("Invalid session in names registry")
                if not isinstance(name, str) or normalize(name) != name:
                    raise ValueError("Invalid name in names registry")
            if len(set(data.values())) != len(data):
                raise ValueError("Duplicate name in names registry")
        except FileNotFoundError:
            data = {}
        yield path, data
    finally:
        os.close(fd)


def snapshot():
    with locked() as (_, data):
        return data


def claim(owner, requested=None):
    if not isinstance(owner, str) or not 0 < len(owner) <= 256:
        raise ValueError("Invalid session ID")
    requested = normalize(requested) if requested is not None else None
    with locked() as (path, data):
        previous = data.get(owner)
        if requested is None and previous:
            return previous
        taken = set(data.values())
        if requested is not None:
            if requested != previous and requested in taken:
                raise ValueError(f"Name '{requested}' is already reserved")
            name = requested
        else:
            choices = [word for word in WORDS if word not in taken]
            if not choices:
                choices = [
                    f"{a}-{b}"
                    for a in PREFIXES
                    for b in WORDS
                    if f"{a}-{b}" not in taken
                ]
            if not choices:
                raise ValueError(
                    "Friendly name pool exhausted; choose a name with /events rename NAME"
                )
            name = secrets.choice(choices)
        if previous == name:
            return name
        data[owner] = name
        text = json.dumps(data, sort_keys=True, indent=2) + "\n"
        if len(text.encode()) > MAX_BYTES:
            raise ValueError("Names registry exceeds size limit")
        fd, temporary = tempfile.mkstemp(prefix=".names-", dir=path.parent)
        try:
            with os.fdopen(fd, "w") as file:
                file.write(text)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, path)
            parent = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
        finally:
            Path(temporary).unlink(missing_ok=True)
        return name


if __name__ == "__main__":
    try:
        if len(sys.argv) not in (2, 3):
            raise ValueError("Expected session ID and optional new name")
        print(claim(sys.argv[1], sys.argv[2] if len(sys.argv) == 3 else None))
    except (OSError, ValueError, TypeError) as error:
        print(f"pi-events names: {error}", file=sys.stderr)
        sys.exit(1)
